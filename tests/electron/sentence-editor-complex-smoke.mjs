import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * Independent real-Electron acceptance coverage for the reference-style
 * sentence editor.  The source IDs and catalog are production content; all
 * writes go to a temporary copy made by createContentProject.
 */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = process.env.RVB_COMPLEX_SENTENCE_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-gameplay-module')
fs.mkdirSync(evidence, { recursive: true })

const allIds = [
  'naruto-shadow-clone',
  'muru-lament',
  'aizen-kyoka-suiguetsu',
  'kiljaedan-demonic-pact',
]
const ids = (process.env.RVB_COMPLEX_SENTENCE_IDS
  ? process.env.RVB_COMPLEX_SENTENCE_IDS.split(',').map(id => id.trim()).filter(Boolean)
  : allIds)
for (const id of ids) assert.ok(allIds.includes(id), `unknown complex sentence ID: ${id}`)
const skipTrial = process.env.RVB_COMPLEX_SENTENCE_SKIP_TRIAL === '1'
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-complex-sentence-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)
const sourceDocuments = {}
for (const id of ids) {
  const document = JSON.parse(fs.readFileSync(path.join(root, 'data', 'skills', `${id}.json`), 'utf8'))
  document.editorComplexSmoke = { marker: 'RED252-complex-sentence', sourceId: id, preserve: true }
  sourceDocuments[id] = document
  fs.writeFileSync(path.join(project, 'data', 'skills', `${id}.json`), JSON.stringify(document, null, 2) + '\n')
}
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

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let socket
let sequence = 0

function callOn(connection, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      connection.removeEventListener('message', onMessage)
      reject(new Error(`CDP timeout: ${method}`))
    }, 30000)
    const onMessage = event => {
      const result = JSON.parse(event.data)
      if (result.id !== id) return
      clearTimeout(timer)
      connection.removeEventListener('message', onMessage)
      if (result.error) reject(new Error(JSON.stringify(result.error)))
      else resolve(result.result)
    }
    connection.addEventListener('message', onMessage)
    connection.send(JSON.stringify({ id, method, params }))
  })
}

function call(method, params = {}) { return callOn(socket, method, params) }

async function evaluateOn(connection, expression) {
  const result = await callOn(connection, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function evaluate(expression) { return evaluateOn(socket, expression) }

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json())
}

async function connectEditor() {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (startupError) throw startupError
    try {
      const target = (await listTargets()).find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        return
      }
    } catch {}
    await delay(250)
  }
  throw new Error('Editor startup timed out')
}

async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function openSkill(id) {
  console.error(`[complex-sentence] opening ${id}`)
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate(`(()=>{
    document.querySelector('[data-tab=skills]').click()
    const item=[...document.querySelectorAll('#skills-list .entity-item')].find(node=>node.querySelector('.id')?.textContent===${JSON.stringify(id)})
    if(!item)throw new Error('missing skill '+${JSON.stringify(id)})
    item.click()
  })()`)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))")
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]'))")) return
    await delay(100)
  }
  const state = await evaluate(`({
    title: document.querySelector('#skills-detail [data-document-title]')?.textContent || '',
    sentenceKind: document.querySelector('#skills-detail [data-sentence-editor]')?.dataset.sentenceKind || '',
    activePane: document.querySelector('#skills-detail .editor-pane.active')?.dataset.editorPane || '',
    graphSummary: Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]')),
    unsupported: Boolean(document.querySelector('#skills-detail [data-sentence-unsupported]')),
    detail: document.querySelector('#skills-detail')?.textContent?.slice(0, 500) || '',
  })`)
  throw new Error(`complex graph projection did not render for ${id}: ${JSON.stringify(state)}`)
}

function draftExpression() {
  return `(()=>{const text=document.querySelector('#skills-detail [data-json-source]')?.value||'';return JSON.parse(text)})()`
}

async function screenshot(name) {
  await call('Page.bringToFront').catch(() => {})
  await call('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  await delay(100)
  const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(evidence, name)
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  return file
}

async function waitForTrainingTarget(previousIds) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const target = (await listTargets()).find(item =>
      item.type === 'page'
      && item.url.includes('/battle.html?mode=training')
      && !previousIds.has(item.id),
    )
    if (target) return target
    await delay(100)
  }
  throw new Error('training preview target did not open')
}

async function inspectTrainingTarget(target) {
  const trainingSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    trainingSocket.addEventListener('open', resolve, { once: true })
    trainingSocket.addEventListener('error', reject, { once: true })
  })
  try {
    let snapshot
    for (let attempt = 0; attempt < 180; attempt++) {
      snapshot = await evaluateOn(trainingSocket, `(async()=>({
        pathname: location.pathname,
        search: location.search,
        ready: document.readyState,
        preview: await fetch('/__editor-preview.json').then(response => response.json()),
        setupVisible: document.getElementById('trainingSetupOverlay')?.classList.contains('show') === true,
        loadingDisplay: document.getElementById('loadingOverlay')?.style.display || '',
        setupOptions: document.querySelectorAll('.training-piece-option input').length,
        skillTemplates: typeof skillsById === 'object' ? Object.keys(skillsById).length : -1,
        pieceTemplates: typeof PIECES_BY_ID === 'object' ? Object.keys(PIECES_BY_ID).length : -1,
      }))()`)
      if (snapshot.ready === 'complete' && (snapshot.setupVisible || snapshot.setupOptions > 0 || snapshot.loadingDisplay === 'none')) return snapshot
      await delay(100)
    }
    return snapshot
  } finally {
    trainingSocket.close()
  }
}

function graphOf(document, field = 'code') {
  return document?.gameplayModules?.entries?.[field]?.graph || null
}

function graphSummary(document) {
  const graph = graphOf(document)
  return {
    version: graph?.version,
    surface: graph?.surface,
    bodyCount: graph?.body?.length || 0,
    bodyIds: (graph?.body || []).map(node => node?.id).filter(Boolean),
    compositeIds: (graph?.composites || []).map(node => node?.id).filter(Boolean),
    continuationIds: (graph?.continuations || []).map(node => node?.id).filter(Boolean),
  }
}

const results = []
const trials = []
let editEvidence = null

try {
  await connectEditor()
  await call('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })

  for (const id of ids) {
    await openSkill(id)
    const before = await evaluate(draftExpression())
    const expected = sourceDocuments[id]
    assert.equal(before.id, id)
    assert.equal(before.kind, expected.kind)
    assert.deepEqual(before.editorComplexSmoke, expected.editorComplexSmoke)
    assert.ok(graphOf(before), `${id} should expose a structured code graph`)

    const rendered = await evaluate(`({
      title: document.querySelector('#skills-detail [data-document-title]')?.textContent || '',
      sentenceKind: document.querySelector('#skills-detail [data-sentence-editor]')?.dataset.sentenceKind || '',
      graphSummary: Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]')),
      unsupported: Boolean(document.querySelector('#skills-detail [data-sentence-unsupported]')),
      controls: document.querySelectorAll('#skills-detail [data-sentence-control]').length,
      nodes: document.querySelectorAll('#skills-detail [data-sentence-node]').length,
      semanticNodes: document.querySelectorAll('#skills-detail .sentence-generic-semantic-step').length,
      advancedCollapsed: document.querySelector('#skills-detail .sentence-generic-advanced-steps')?.open !== true,
      nodeKinds: [...new Set([...document.querySelectorAll('#skills-detail [data-sentence-node-kind]')].map(node => node.dataset.sentenceNodeKind))],
      text: document.querySelector('#skills-detail [data-sentence-graph-summary]')?.textContent || '',
      visibleText: [...document.querySelectorAll('#skills-detail .sentence-generic-semantic-list')].map(node => node.textContent || '').join(' '),
    })`)
    assert.match(rendered.title, new RegExp(expected.name))
    assert.equal(rendered.sentenceKind, expected.kind)
    assert.equal(rendered.graphSummary, true)
    assert.equal(rendered.unsupported, false)
    assert.equal(rendered.controls, 0, `${id} is a complex graph and must not expose an incorrect simple damage control`)
    assert.ok(rendered.nodes > 0, `${id} should render graph nodes`)
    assert.ok(rendered.semanticNodes > 0, `${id} should expose at least one readable behavior step`)
    assert.equal(rendered.advancedCollapsed, true, `${id} technical graph steps should be collapsed by default`)
    assert.ok(!/(source-present|query\.|attribute\.|math\.|record\.)/.test(rendered.visibleText), `${id} default projection should hide plumbing identifiers`)
    assert.ok(rendered.text.includes('点击蓝色参数即可修改'), `${id} should expose the readable graph projection`)
    const defaultScreenshot = await screenshot(`sentence-editor-complex-${id}-default.png`)

    const beforeAdvanced = graphSummary(before)
    await evaluate("document.querySelector('#skills-detail [data-sentence-advanced]').click()")
    await until("document.querySelector('#skills-detail [data-editor-pane=graph].active') && document.querySelector('#skills-detail [data-gameplay-modules]')")
    const advanced = await evaluate(`({
      pane: document.querySelector('#skills-detail [data-editor-pane=graph]')?.classList.contains('active') === true,
      statements: document.querySelectorAll('#skills-detail [data-gameplay-module-statement]').length,
      moduleEditor: Boolean(document.querySelector('#skills-detail [data-gameplay-modules]')),
      graphText: document.querySelector('#skills-detail [data-gameplay-modules]')?.textContent || '',
    })`)
    assert.equal(advanced.pane, true)
    assert.equal(advanced.moduleEditor, true)
    assert.ok(advanced.statements > 0, `${id} advanced view should expose graph statements`)
    const advancedScreenshot = await screenshot(`sentence-editor-complex-${id}-advanced.png`)

    await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
    let saveState = ''
    for (let attempt = 0; attempt < 180; attempt++) {
      saveState = await evaluate(`({
        footer: document.querySelector('#skills-detail [data-footer-state]')?.textContent || '',
        header: document.querySelector('#skills-detail .editor-header .dirty-state')?.textContent || '',
        disabled: document.querySelector('#skills-detail [data-save-json]')?.disabled === true,
        jsonError: document.querySelector('#skills-detail [data-json-error]')?.textContent || '',
        graphError: document.querySelector('#skills-detail [data-gameplay-module-error]')?.textContent || '',
      })`)
      if (saveState.footer === '已保存') break
      await delay(100)
    }
    assert.equal(saveState.footer, '已保存', `${id} save did not complete: ${JSON.stringify(saveState)}`)
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', `${id}.json`), 'utf8'))
    assert.deepEqual(persisted, expected, `${id} no-op save must preserve the exact document and metadata`)

    await call('Page.reload')
    await openSkill(id)
    const reloaded = await evaluate(draftExpression())
    assert.deepEqual(reloaded, expected, `${id} graph/metadata must survive page reload`)
    assert.deepEqual(graphSummary(reloaded), beforeAdvanced)
    const clusterScreenshot = await screenshot(`sentence-editor-complex-${id}.png`)

    if (!skipTrial) {
      const targetIdsBeforeTrial = new Set((await listTargets()).filter(item => item.type === 'page' && item.url.includes('/battle.html?mode=training')).map(item => item.id))
      assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-trial]'))"), true, `${id} should expose the trial action`)
      await evaluate("document.querySelector('#skills-detail [data-sentence-trial]').click()")
      let trialMessage = ''
      for (let attempt = 0; attempt < 180; attempt++) {
        trialMessage = await evaluate("document.querySelector('#skills-detail .sentence-message')?.textContent || ''")
        if (trialMessage.includes('训练营已打开')) break
        if (trialMessage.includes('试用失败')) throw new Error(`${id} trial failed: ${trialMessage}`)
        await delay(100)
      }
      assert.match(trialMessage, /训练营已打开/, `${id} trial message did not arrive`)
      const target = await waitForTrainingTarget(targetIdsBeforeTrial)
      const preview = await inspectTrainingTarget(target)
      assert.equal(preview.pathname, '/battle.html')
      assert.equal(preview.search, '?mode=training')
      assert.equal(preview.ready, 'complete')
      assert.equal(preview.preview.mode, 'training')
      assert.equal(preview.preview.acceptedOnly, false)
      assert.equal(preview.preview.draft.skillId, id)
      assert.ok(preview.preview.draft.pieceId)
      assert.equal(preview.setupVisible, true, `${id} trial should show the training setup`)
      assert.equal(preview.loadingDisplay, 'none', `${id} trial should finish loading`)
      assert.ok(preview.setupOptions > 0, `${id} trial should expose available piece choices`)
      trials.push({ id, targetId: target.id, url: target.url, draft: preview.preview.draft, setupVisible: preview.setupVisible })
    }

    results.push({
      id,
      name: expected.name,
      kind: expected.kind,
      graph: beforeAdvanced,
      rendered: { nodes: rendered.nodes, semanticNodes: rendered.semanticNodes, nodeKinds: rendered.nodeKinds },
      advanced: { statements: advanced.statements },
      screenshots: [defaultScreenshot, advancedScreenshot, clusterScreenshot],
    })

    if (id === 'naruto-shadow-clone') {
      await evaluate("document.querySelector('#skills-detail [data-editor-mode=cluster]').click()")
      await until("Boolean(document.querySelector('#skills-detail [data-sentence-add-condition]'))")
      const originalBodyIds = graphSummary(reloaded).bodyIds
      await evaluate("document.querySelector('#skills-detail [data-sentence-add-condition]').click()")
      const edited = await evaluate(draftExpression())
      const added = graphOf(edited).body.find(node => node?.kind === 'if' && node.id?.startsWith('sentence-condition-'))
      assert.ok(added, 'sentence-level condition control must add an if node to the current graph')
      assert.notDeepEqual(graphSummary(edited).bodyIds, originalBodyIds)
      await evaluate("document.querySelector('#skills-detail [data-sentence-save]').click()")
      await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
      const editedPersisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', `${id}.json`), 'utf8'))
      assert.deepEqual(editedPersisted, edited, 'the edited graph must be the graph written by Save')
      assert.deepEqual(editedPersisted.editorComplexSmoke, expected.editorComplexSmoke)
      await call('Page.reload')
      await openSkill(id)
      const editedReloaded = await evaluate(draftExpression())
      assert.deepEqual(editedReloaded, edited, 'the edited graph and metadata must survive reload')
      editEvidence = { id, addedNodeId: added.id, beforeBodyIds: originalBodyIds, afterBodyIds: graphSummary(edited).bodyIds }
    }
  }

  const report = {
    ok: true,
    sourceIds: ids,
    checks: [
      'production catalog IDs opened in real Electron',
      'complex graph sentence projection rendered without false simple controls',
      'advanced route opened and exposed registered statements',
      'no-op save preserved exact graph and unknown metadata',
      'page reload preserved exact graph and metadata',
      ...(editEvidence ? ['sentence condition control changed the correct Naruto graph', 'changed graph and metadata saved and reloaded exactly'] : []),
      ...(skipTrial ? [] : [`${ids.length === allIds.length ? 'active and passive' : 'requested'} skill trial opened isolated training preview routes`]),
    ],
    results,
    trials,
    edit: editEvidence,
    screenshots: results.flatMap(result => result.screenshots),
    project,
  }
  fs.writeFileSync(path.join(evidence, 'sentence-editor-complex-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  try { socket?.close() } catch {}
  child.kill()
}
