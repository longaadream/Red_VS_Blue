import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-draft-training-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)
const sourceFile = path.join(project, 'data/skills/fireball.json')
const sourceBefore = fs.readFileSync(sourceFile)
const draftSkill = JSON.parse(sourceBefore.toString('utf8'))
draftSkill.powerMultiplier = 3
const draftRequest = { skillId: 'fireball', drafts: [{ collection: 'skills', document: draftSkill }] }
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }))

const listener = await new Promise(resolve => {
  const server = require('node:net').createServer()
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const port = listener.address().port
listener.close()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(process.env.RVB_GRAPH_ELECTRON_BINARY, [path.join(root, 'electron-editor/dist/main.js'), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], { env, windowsHide: true, stdio: 'ignore' })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sockets = []
async function connect(match) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const tab = tabs.find(candidate => candidate.type === 'page' && match(candidate.url))
      if (tab) {
        const socket = new WebSocket(tab.webSocketDebuggerUrl)
        await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
        sockets.push(socket)
        let sequence = 0
        const call = (method, params = {}) => new Promise((resolve, reject) => {
          const id = ++sequence
          const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 120000)
          const onMessage = event => {
            const value = JSON.parse(event.data)
            if (value.id !== id) return
            clearTimeout(timer)
            socket.removeEventListener('message', onMessage)
            if (value.error) reject(new Error(JSON.stringify(value.error))); else resolve(value.result)
          }
          socket.addEventListener('message', onMessage)
          socket.send(JSON.stringify({ id, method, params }))
        })
        const evaluate = async expression => {
          const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
          return result.result.value
        }
        return { call, evaluate }
      }
    } catch {}
    await delay(200)
  }
  throw new Error('编辑器窗口启动超时')
}
async function until(client, expression) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await client.evaluate(expression)) return
    await delay(100)
  }
  throw new Error('等待条件超时：' + expression)
}

try {
  const editor = await connect(url => url.includes('index.html'))
  const result = await editor.evaluate(`editorAPI.skillTrial(${JSON.stringify(draftRequest)})`)
  assert.match(result.contentHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore)
  const training = await connect(url => url.startsWith('rvb-editor-training:'))
  await until(training, "Boolean(document.querySelector('#trainingFirstPieces input'))")
  const marker = await training.evaluate("fetch('./__editor-preview.json').then(response => response.json())")
  assert.equal(marker.acceptedOnly, false)
  assert.equal(marker.draft.skillId, 'fireball')
  assert.equal(marker.draft.pieceId, 'jaina')
  const trial = await training.evaluate(`fetch('./data/pieces/${marker.draft.pieceId}.json').then(response => response.json())`)
  assert.equal(trial.name, '试用 · 火球术')
  assert.equal(trial.faction, 'good')
  await training.evaluate(`(()=>{
    const first = document.querySelector('#trainingFirstFaction'); const second = document.querySelector('#trainingSecondFaction')
    first.value = 'blue'; second.value = 'red'; refreshTrainingSetupPieces()
    for (const input of document.querySelectorAll('#trainingFirstPieces input')) input.checked = input.value === ${JSON.stringify(marker.draft.pieceId)}
    for (const input of document.querySelectorAll('#trainingSecondPieces input')) input.checked = input.value === 'dark-ulquiorra'
    startTrainingFromSetup()
  })()`)
  await until(training, "typeof G !== 'undefined' && G && Array.isArray(G.pieces) && G.pieces.some(piece => piece.templateId === '" + marker.draft.pieceId + "')")
  const combat = await training.evaluate(`(async()=>{
    const caster = G.pieces.find(piece => piece.templateId === ${JSON.stringify(marker.draft.pieceId)})
    const target = G.pieces.find(piece => piece.ownerPlayerId !== caster.ownerPlayerId && piece.currentHp > 0)
    caster.x = 1; caster.y = 1; target.x = 2; target.y = 1; target.currentHp = 40; target.maxHp = 40; target.defense = 0
    const before = target.currentHp; const oldG = G
    G = await trainingApiFetch('PUT', { battleState: G, action: await prepareTutorialTargetAction({ type: 'useBasicSkill', playerId: caster.ownerPlayerId, pieceId: caster.instanceId, skillId: 'fireball', clientActionId: 'draft-fireball' }, { targetPieceId: target.instanceId }) })
    renderBoard(); flushActionLog(oldG, G)
    return { before, after: G.pieces.find(piece => piece.instanceId === target.instanceId).currentHp, log: document.querySelector('#logBody')?.textContent || '', rules: G.pieces.find(piece => piece.instanceId === caster.instanceId).rules || [] }
  })()`)
  assert.notEqual(draftSkill.powerMultiplier, JSON.parse(sourceBefore.toString('utf8')).powerMultiplier)
  assert.equal(combat.before - combat.after, 11)
  assert.match(combat.log, /火球术/)
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore)
  console.log(JSON.stringify({ ok: true, contentHash: result.contentHash, combat }))
} finally {
  for (const socket of sockets) socket.close()
  child.kill()
}
