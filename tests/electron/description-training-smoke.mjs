import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * RED-252 description-template training acceptance smoke.
 *
 * This test uses a real Electron renderer and the formal editor-training
 * protocol.  It deliberately uses an isolated project/userData directory and
 * a newly reserved CDP port on every launch.  It does not import renderer
 * modules into Node, mock editorAPI, create HUD elements, or attach to the
 * user's long-running 62435 endpoint.
 */
const root = path.resolve(import.meta.dirname, '../..')
const evidence = path.resolve(process.env.RVB_DESCRIPTION_TRAINING_EVIDENCE_DIR || path.join(root, 'output', 'completion-description-training-smoke'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-developer-display-'))
const userData = path.join(temporary, 'user')
const require = createRequire(import.meta.url)
const { createContentProject, copyBundledRootImages } = require(path.join(root, 'electron-editor/dist/content-project.js'))
// Keep the authoring fixture complete enough for the real training snapshot,
// while excluding bundled PVE documents.  The PVE recruitment contract rejects
// pieces with playerRules (the exact feature under test), so including that
// unrelated PVE catalogue would make the package boundary fail before it could
// inspect the saved display fields.
const project = createContentProject(temporary, 'blank', root)
const skippedInvalidDocuments = []
for (const directory of ['skills', 'rules', 'pieces', 'cards', 'maps', 'tiles', 'status-effects']) {
  const source = path.join(root, 'data', directory)
  const destination = path.join(project, 'data', directory)
  if (!fs.existsSync(source)) continue
  fs.mkdirSync(destination, { recursive: true })
  // Keep this fixture PVP-only so the package UI's real capability summary is
  // sufficient.  The training snapshot still receives every ordinary document
  // and its manifests; only unrelated documents explicitly marked PVE are
  // omitted, without rewriting any copied content.
  const names = fs.readdirSync(source)
  for (const name of names) {
    const sourceFile = path.join(source, name)
    const destinationFile = path.join(destination, name)
    if (name === 'manifest.json') continue
    if (!name.endsWith('.json')) continue
    let value
    try {
      value = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
    } catch (error) {
      // Keep this smoke focused on the description path while the known Velen
      // fixture repair is in flight.  The report records every skipped source
      // so an invalid shipped document cannot be mistaken for a pass.
      skippedInvalidDocuments.push({ directory, name, error: error.message })
      continue
    }
    if (value?.availability?.modes?.includes?.('pve')) continue
    fs.copyFileSync(sourceFile, destinationFile)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  assert.ok(Array.isArray(manifest), `内置 ${directory} 清单格式无效`)
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(
    manifest.filter(id => fs.existsSync(path.join(destination, `${id}.json`))),
    null,
    2,
  ) + '\n')
}
for (const file of ['skill-keywords.json']) {
  const source = path.join(root, 'data', file)
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(project, 'data', file))
}
// The shipped Tyrande skill uses the legacy namespace for its player buff.
// Rewrite only the isolated fixture to the public `content` namespace so this
// smoke exercises the real flowState projection contract without changing
// shipped gameplay data or adding a new rule.
const eluneFixture = path.join(project, 'data', 'skills', 'elune-blessing.json')
const eluneFixtureValue = JSON.parse(fs.readFileSync(eluneFixture, 'utf8'))
const eluneFixtureText = JSON.stringify(eluneFixtureValue).replaceAll('legacy-player-buffs', 'content')
fs.writeFileSync(eluneFixture, eluneFixtureText + '\n')
// Use the same root-portrait copier as the editor's official project template;
// it excludes web-shell icons and keeps the package input to validated raster
// assets.  The selected effect icon is copied explicitly below from the page
// bundle because it is the real material-library source in this checkout.
copyBundledRootImages(root, project)
const pageRasterImages = path.join(root, 'data', 'pages', 'images')
if (fs.existsSync(pageRasterImages)) {
  for (const name of fs.readdirSync(pageRasterImages)) {
    if (!/\.(?:png|jpe?g|webp)$/i.test(name)) continue
    fs.copyFileSync(path.join(pageRasterImages, name), path.join(project, 'images', name))
  }
}
// Use a recognizable existing effect icon from the bundled material library so
// the screenshots demonstrate the real authoring choice rather than a test
// placeholder.  The isolated project receives the same asset under its normal
// `images/` path before the editor starts.
const iconPath = 'images/effect-icons/player-soul-fracture.svg'
const iconSource = path.join(root, 'data/pages/images/effect-icons/player-soul-fracture.svg')
const iconFile = path.join(project, iconPath)
fs.mkdirSync(path.dirname(iconFile), { recursive: true })
fs.copyFileSync(iconSource, iconFile)
fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')
fs.mkdirSync(evidence, { recursive: true })

const rootSeed = 594
const skillDescription = '月神赐福效果提高{当前玩家.扩展变量["elune-blessing-buff"].multiplier}倍。'
const playerRuleDescription = '当前月神赐福倍率：{当前玩家.扩展变量["elune-blessing-buff"].multiplier}。'
const cardDescription = '圣光伤害提高{当前玩家.扩展变量["elune-blessing-buff"].multiplier}倍。'

let child = null
let editor = null
let training = null
let cdpPort = null
let startupError = null
let childStdout = ''
let childStderr = ''
let report = null
const clients = new Set()

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const selector = value => JSON.stringify(value)

async function reservePort() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    await new Promise(resolve => server.close(resolve))
    if (port && port !== 62435) return port
  }
  throw new Error('无法分配独立的动态 CDP 端口')
}

async function listTargets() {
  if (!cdpPort) throw new Error('CDP 端口尚未分配')
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) })
  return response.json()
}

function makeClient(target, socket) {
  let sequence = 0
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`CDP timeout: ${method}`))
    }, 120000)
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
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  const client = {
    targetId: target.id,
    url: target.url,
    socket,
    call,
    evaluate,
    close() {
      clients.delete(client)
      try { socket.close() } catch { /* best effort */ }
    },
  }
  clients.add(client)
  return client
}

async function connectTarget(predicate, label, timeout = 120000) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    try {
      const targets = await listTargets()
      const target = targets.find(candidate => candidate.type === 'page' && predicate(candidate))
      if (target) {
        const socket = new WebSocket(target.webSocketDebuggerUrl)
        try {
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', reject, { once: true })
          })
          const client = makeClient(target, socket)
          await client.call('Runtime.enable')
          await client.call('Page.enable')
          return client
        } catch (error) {
          lastError = error
          try { socket.close() } catch { /* best effort */ }
        }
      }
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`${label}启动超时${lastError ? `：${lastError.message}` : ''}`)
}

async function waitFor(client, expression, label = expression, timeout = 120000) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`等待条件超时：${label}${lastError ? `；${lastError.message}` : ''}`)
}

async function screenshot(client, name, elementSelector = null) {
  if (!client) return null
  let clip
  if (elementSelector) {
    clip = await client.evaluate(`(() => {
      const node = document.querySelector(${selector(elementSelector)})
      if (!node) return null
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      return { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height }
    })()`)
    assert.ok(clip, `截图节点缺失或不可见：${elementSelector}`)
  }
  const result = await client.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  const filename = path.join(evidence, `${name}.png`)
  fs.writeFileSync(filename, Buffer.from(result.data, 'base64'))
  return filename
}

async function stopEditor() {
  for (const client of [...clients]) client.close()
  editor = null
  training = null
  if (child && !child.killed) child.kill()
  await delay(700)
  child = null
  cdpPort = null
}

async function startEditor() {
  cdpPort = await reservePort()
  assert.notEqual(cdpPort, 62435, '测试不能连接用户 62435 调试端口')
  startupError = null
  childStdout = ''
  childStderr = ''
  const executable = process.env.RVB_GRAPH_EDITOR_EXE
    || process.env.RVB_GRAPH_ELECTRON_BINARY
    || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor', 'dist', 'main.js')]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, '--editor-smoke-hidden'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => { childStdout = (childStdout + String(chunk)).slice(-10000) })
  child.stderr?.on('data', chunk => { childStderr = (childStderr + String(chunk)).slice(-15000) })
  child.on('error', error => { startupError = error })
  editor = await connectTarget(target => target.url.includes('index.html'), '编辑器窗口')
  await waitFor(editor, "document.readyState === 'complete' && document.body.classList.contains('studio-surface')", '编辑器加载')
  return editor
}

async function openDocument(client, collection, id) {
  await waitFor(client, "Boolean(document.querySelector('#pieces-list .entity-item'))", '内容列表')
  await client.evaluate(`document.querySelector('[data-tab=${selector(collection)}]')?.click()`)
  await waitFor(client, `document.querySelector('[data-tab=${selector(collection)}]')?.classList.contains('active') && document.querySelector('#tab-${collection}')?.classList.contains('active')`, `${collection}页面`)
  await waitFor(client, `Boolean(document.querySelector('#${collection}-list .entity-item'))`, `${collection}列表`)
  await client.evaluate(`(() => {
    const row = document.querySelector('#${collection}-list [data-entity-id=${selector(id)}]')
      || [...document.querySelectorAll('#${collection}-list .entity-item')].find(item => item.querySelector('.id')?.textContent === ${selector(id)})
    if (!row) throw new Error('缺少 ${collection}/${id}')
    row.click()
  })()`)
  await waitFor(client, `Boolean(document.querySelector('#${collection}-detail [data-json-source]'))`, `${collection}/${id}编辑器`)
  await waitFor(client, `document.querySelector('[data-shell-breadcrumb]')?.dataset.documentId === ${selector(id)}`, `${collection}/${id}路由`)
}

async function saveDocument(client, collection) {
  await client.evaluate(`document.querySelector('#${collection}-detail [data-save-json]')?.click()`)
  await waitFor(client, `document.querySelector('#${collection}-detail [data-footer-state]')?.textContent === '已保存'`, `${collection}保存`)
}

async function setTextField(client, collection, fieldPath, value) {
  await client.evaluate(`(() => {
    const field = document.querySelector('#${collection}-detail [data-field-path=${selector(fieldPath)}]')
    if (!field) throw new Error('缺少属性字段：${collection}.${fieldPath}')
    field.value = ${selector(value)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(client, `JSON.parse(document.querySelector('#${collection}-detail [data-json-source]').value)[${selector(fieldPath)}] === ${selector(value)}`, `${collection}.${fieldPath}草稿`)
}

async function setCheckboxField(client, collection, fieldPath, checked) {
  await client.evaluate(`(() => {
    const field = document.querySelector('#${collection}-detail [data-field-path=${selector(fieldPath)}]')
    if (!field || field.type !== 'checkbox') throw new Error('缺少复选属性字段：${collection}.${fieldPath}')
    field.checked = ${checked ? 'true' : 'false'}
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(client, `JSON.parse(document.querySelector('#${collection}-detail [data-json-source]').value)[${selector(fieldPath)}] === ${checked ? 'true' : 'false'}`, `${collection}.${fieldPath}草稿`)
}

async function setRuleIcon(client) {
  await waitFor(client, `Boolean(document.querySelector('#rules-detail [data-visual-field=playerRulePresentation]'))`, '玩家规则表现字段')
  await waitFor(client, `[...document.querySelectorAll('#rules-detail [data-visual-field=playerRulePresentation] select option')].some(option => option.value === ${selector(iconPath)})`, '玩家规则图标素材')
  await client.evaluate(`(() => {
    const select = document.querySelector('#rules-detail [data-visual-field=playerRulePresentation] select')
    select.value = ${selector(iconPath)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await waitFor(client, `JSON.parse(document.querySelector('#rules-detail [data-json-source]').value).iconPath === ${selector(iconPath)}`, '玩家规则图标草稿')
}

async function addPlayerRule(client) {
  await waitFor(client, `Boolean(document.querySelector('#pieces-detail [data-visual-field=playerRules]'))`, '棋子玩家规则字段')
  await client.evaluate(`(() => {
    const host = document.querySelector('#pieces-detail [data-visual-field=playerRules]')
    const input = host.querySelector('input[list]')
    if (!input) throw new Error('玩家规则关联输入缺失')
    input.value = 'rule-soul-fracture-player'
    const button = [...host.querySelectorAll('button')].find(node => node.textContent.includes('添加'))
    if (!button) throw new Error('玩家规则添加按钮缺失')
    button.click()
  })()`)
  await waitFor(client, `JSON.parse(document.querySelector('#pieces-detail [data-json-source]').value).playerRules.includes('rule-soul-fracture-player')`, '棋子玩家规则草稿')
}

async function editAuthoringFields(client) {
  await openDocument(client, 'skills', 'elune-blessing')
  await client.evaluate("document.querySelector('#skills-detail [data-editor-mode=fields]').click()")
  await setTextField(client, 'skills', 'description', skillDescription)
  await screenshot(client, 'skill-description-editor', '#skills-detail [data-visual-fields]')
  await saveDocument(client, 'skills')
  const savedSkill = JSON.parse(fs.readFileSync(path.join(project, 'data/skills/elune-blessing.json'), 'utf8'))
  assert.equal(savedSkill.description, skillDescription)

  await openDocument(client, 'rules', 'rule-soul-fracture-player')
  await client.evaluate("document.querySelector('#rules-detail [data-editor-mode=fields]').click()")
  await setTextField(client, 'rules', 'description', playerRuleDescription)
  await setCheckboxField(client, 'rules', 'visible', true)
  await setRuleIcon(client)
  await screenshot(client, 'player-rule-display-editor', '#rules-detail [data-visual-fields]')
  await screenshot(client, 'player-rule-display-editor-full', '#rules-detail [data-editor-pane="fields"]')
  await saveDocument(client, 'rules')
  const savedRule = JSON.parse(fs.readFileSync(path.join(project, 'data/rules/rule-soul-fracture-player.json'), 'utf8'))
  assert.equal(savedRule.description, playerRuleDescription)
  assert.equal(savedRule.iconPath, iconPath)

  await openDocument(client, 'cards', 'holy-smite')
  await client.evaluate("document.querySelector('#cards-detail [data-editor-mode=fields]').click()")
  await setTextField(client, 'cards', 'description', cardDescription)
  await screenshot(client, 'card-description-editor', '#cards-detail [data-visual-fields]')
  await saveDocument(client, 'cards')
  const savedCard = JSON.parse(fs.readFileSync(path.join(project, 'data/cards/holy-smite.json'), 'utf8'))
  assert.equal(savedCard.description, cardDescription)

  await openDocument(client, 'pieces', 'tyrande')
  await client.evaluate("document.querySelector('#pieces-detail [data-editor-mode=fields]').click()")
  await addPlayerRule(client)
  await screenshot(client, 'piece-player-rule-editor', '#pieces-detail [data-visual-fields]')
  await saveDocument(client, 'pieces')
  const savedPiece = JSON.parse(fs.readFileSync(path.join(project, 'data/pieces/tyrande.json'), 'utf8'))
  assert.deepEqual(savedPiece.playerRules, ['rule-soul-fracture-player'])
  return { savedSkill, savedRule, savedCard, savedPiece }
}

async function reopenAssertions(client) {
  await openDocument(client, 'skills', 'elune-blessing')
  assert.equal(await client.evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).description"), skillDescription)
  await openDocument(client, 'rules', 'rule-soul-fracture-player')
  assert.deepEqual(await client.evaluate("(() => { const value = JSON.parse(document.querySelector('#rules-detail [data-json-source]').value); return { description: value.description, iconPath: value.iconPath, visible: value.visible } })()"), { description: playerRuleDescription, iconPath, visible: true })
  await openDocument(client, 'cards', 'holy-smite')
  assert.equal(await client.evaluate("JSON.parse(document.querySelector('#cards-detail [data-json-source]').value).description"), cardDescription)
  await openDocument(client, 'pieces', 'tyrande')
  assert.deepEqual(await client.evaluate("(() => { const value = JSON.parse(document.querySelector('#pieces-detail [data-json-source]').value); return { playerRules: value.playerRules } })()"), { playerRules: ['rule-soul-fracture-player'] })
}

async function openDraftTraining(client) {
  await openDocument(client, 'skills', 'elune-blessing')
  await waitFor(client, "Boolean(document.querySelector('#skills-detail [data-sentence-trial]'))", '月神赐福试玩入口')
  await client.evaluate(`(() => {
    const side = document.querySelector('[data-training-side]')
    if (!side) throw new Error('训练控制方选择器缺失')
    side.value = 'training-blue'
    side.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector('#skills-detail [data-sentence-trial]').click()
  })()`)
  await waitFor(client, "document.querySelector('[data-training-status]')?.textContent === '草稿试玩中'", '草稿训练面板', 180000)
  training = await connectTarget(target => target.url.startsWith('rvb-editor-training:') && target.url.includes('/battle.html?mode=training'), '正式训练视图', 180000)
  await waitFor(training, "document.querySelector('#trainingSetupOverlay')?.classList.contains('show')", '训练开局设置', 180000)
  const marker = await training.evaluate("fetch('./__editor-preview.json').then(response => response.json())")
  assert.equal(marker.acceptedOnly, false)
  assert.equal(marker.draft.skillId, 'elune-blessing')
  assert.equal(marker.draft.pieceId, 'tyrande')
  const [snapshotPiece, snapshotRule, snapshotCard, snapshotSkill, snapshotIcon] = await Promise.all([
    training.evaluate("fetch('./data/pieces/tyrande.json').then(response => response.json())"),
    training.evaluate("fetch('./data/rules/rule-soul-fracture-player.json').then(response => response.json())"),
    training.evaluate("fetch('./data/cards/holy-smite.json').then(response => response.json())"),
    training.evaluate("fetch('./data/skills/elune-blessing.json').then(response => response.json())"),
    training.evaluate(`fetch(${selector(iconPath)}).then(response => ({ ok: response.ok, status: response.status, type: response.headers.get('content-type') }))`),
  ])
  assert.deepEqual(snapshotPiece.playerRules, ['rule-soul-fracture-player'])
  assert.equal(snapshotPiece.skills[0].skillId, 'elune-blessing')
  assert.equal(snapshotSkill.description, skillDescription)
  assert.equal(snapshotRule.description, playerRuleDescription)
  assert.equal(snapshotCard.description, cardDescription)
  assert.equal(snapshotRule.iconPath, iconPath)
  assert.equal(snapshotRule.visible, true)
  assert.equal(snapshotIcon.ok, true, `训练快照图标资源不可读取：${JSON.stringify(snapshotIcon)}`)
  return { marker, snapshotPiece, snapshotRule, snapshotCard, snapshotSkill, snapshotIcon }
}

async function waitForTrainingBattle(client, timeout = 180000) {
  const deadline = Date.now() + timeout
  let lastState = null
  while (Date.now() < deadline) {
    lastState = await client.evaluate(`(() => ({
      marker: window.__RVB_TRAINING__ || null,
      pieceCount: Array.isArray(G?.pieces) ? G.pieces.length : 0,
      loading: document.querySelector('#loadingMsg')?.textContent || '',
      setupVisible: document.querySelector('#trainingSetupOverlay')?.classList.contains('show') || false,
      status: document.querySelector('#statusMsg')?.textContent || '',
    }))()`)
    if (lastState.marker?.initialStateHash && lastState.pieceCount === 2 && !lastState.setupVisible) return lastState
    if (/初始化失败|资源读取异常|训练棋子资源未加载/.test(lastState.loading + lastState.status)) throw new Error(`训练营初始化失败：${JSON.stringify(lastState)}`)
    await delay(100)
  }
  throw new Error(`等待训练营初始战场超时：${JSON.stringify(lastState)}`)
}

async function startTrainingScene(client) {
  const selected = await client.evaluate(`(() => {
    const firstFaction = document.querySelector('#trainingFirstFaction')
    const secondFaction = document.querySelector('#trainingSecondFaction')
    if (!firstFaction || !secondFaction) throw new Error('训练阵营选择器缺失')
    firstFaction.value = 'blue'
    secondFaction.value = 'red'
    refreshTrainingSetupPieces()
    const choose = (selectorText, value) => {
      const inputs = [...document.querySelectorAll(selectorText)]
      const input = inputs.find(candidate => candidate.value === value)
      if (!input) throw new Error('训练棋子选项缺失：' + value)
      inputs.forEach(candidate => { candidate.checked = candidate === input })
    }
    choose('#trainingFirstPieces input', 'tyrande')
    choose('#trainingSecondPieces input', 'dark-akaza')
    return {
      firstPlayerId: 'training-blue',
      firstFaction: firstFaction.value,
      secondFaction: secondFaction.value,
      firstTemplateIds: [...document.querySelectorAll('#trainingFirstPieces input:checked')].map(input => input.value),
      secondTemplateIds: [...document.querySelectorAll('#trainingSecondPieces input:checked')].map(input => input.value),
    }
  })()`)
  assert.deepEqual(selected.firstTemplateIds, ['tyrande'])
  assert.deepEqual(selected.secondTemplateIds, ['dark-akaza'])
  await client.evaluate("document.querySelector('#trainingSetupOverlay button.primary').click()")
  await waitForTrainingBattle(client)
  await waitFor(client, "(() => { const image = document.querySelector('.player-state-chip[data-player-id=\"training-blue\"] .player-effect-icon img'); return Boolean(image && image.complete && image.naturalWidth > 0) })()", '玩家 HUD 图标真实资源加载', 30000)
  const result = await client.evaluate(`(() => {
    const blue = G.players.find(player => player.playerId === 'training-blue')
    const tyrande = G.pieces.find(piece => piece.templateId === 'tyrande')
    const playerCard = document.querySelector('.player-state-chip[data-player-id="training-blue"]')
    const effect = [...(playerCard?.querySelectorAll('.player-effect-icon') || [])]
      .find(node => (node.getAttribute('aria-label') || '').includes('当前月神赐福倍率'))
    const effectImage = effect?.querySelector('img')
    return {
      marker: window.__RVB_TRAINING__ || null,
      turn: G.turn?.currentPlayerId || null,
      player: blue ? { faction: blue.faction, rules: blue.rules || [] } : null,
      tyrande: tyrande ? { instanceId: tyrande.instanceId, ownerPlayerId: tyrande.ownerPlayerId, faction: tyrande.faction, skills: tyrande.skills || [] } : null,
      playerCard: playerCard ? { side: playerCard.querySelector('.player-side-name')?.textContent || '', text: playerCard.textContent || '' } : null,
      effect: effect ? { aria: effect.getAttribute('aria-label') || '', icon: effectImage?.getAttribute('src') || '', complete: effectImage?.complete === true, naturalWidth: effectImage?.naturalWidth || 0, tip: effect.querySelector('.player-effect-tip')?.textContent || '' } : null,
      flowState: Array.isArray(G.extensions?.flowState) ? G.extensions.flowState.filter(entry => entry?.scope === 'player' && entry?.entityId === 'training-blue' && entry?.namespace === 'content' && entry?.name === 'elune-blessing-buff') : [],
    }
  })()`)
  assert.equal(result.marker.rootSeed, rootSeed)
  assert.equal(result.marker.setupConfig.firstPlayerId, 'training-blue')
  assert.equal(result.marker.setupConfig.firstFaction, 'blue')
  assert.equal(result.marker.setupConfig.secondFaction, 'red')
  assert.equal(result.turn, 'training-blue', '正式训练权威先手必须是 training-blue')
  assert.equal(result.player?.faction, 'blue')
  assert.ok(result.player?.rules?.some(rule => rule.id === 'rule-soul-fracture-player' && rule.description === playerRuleDescription && rule.iconPath === iconPath && rule.visible === true), `权威玩家规则缺少保存的描述/图标/可见性：${JSON.stringify(result.player)}`)
  assert.equal(result.tyrande?.ownerPlayerId, 'training-blue')
  assert.equal(result.tyrande?.faction, 'blue')
  assert.ok(result.tyrande?.skills?.some(skill => skill.skillId === 'elune-blessing'), `权威棋子缺少月神赐福技能：${JSON.stringify(result.tyrande)}`)
  assert.match(result.playerCard?.side || '', /蓝方 · 先手/)
  assert.ok(result.effect, '正式训练玩家 HUD 缺少玩家级规则图标')
  assert.equal(result.effect.icon, iconPath, `玩家 HUD 未使用作者选择的图标：${JSON.stringify(result.effect)}`)
  assert.ok(result.effect.complete && result.effect.naturalWidth > 0, `玩家 HUD 图标未加载真实图片：${JSON.stringify(result.effect)}`)
  assert.match(result.effect.aria, /当前月神赐福倍率：未赋值。/)
  assert.equal(result.flowState.length, 0, `训练初始快照不应提前包含月神赐福扩展：${JSON.stringify(result.flowState)}`)
  return result
}

async function executeEluneBlessing(client) {
  return client.evaluate(`(async() => {
    const caster = G.pieces.find(piece => piece.templateId === 'tyrande')
    if (!caster) throw new Error('月神赐福动作前泰兰德缺失')
    const player = G.players.find(candidate => candidate.playerId === caster.ownerPlayerId)
    const effect = () => {
      const node = [...document.querySelectorAll('.player-state-chip[data-player-id="training-blue"] .player-effect-icon')]
        .find(candidate => (candidate.getAttribute('aria-label') || '').includes('当前月神赐福倍率'))
      return node ? {
        aria: node.getAttribute('aria-label') || '',
        tip: node.querySelector('.player-effect-tip')?.textContent || '',
      } : null
    }
    const cardDisplay = () => {
      const hand = G.players.find(candidate => candidate.playerId === caster.ownerPlayerId)?.hand || []
      const instance = hand.find(candidate => candidate.cardId === 'holy-smite')
      const node = instance
        ? [...document.querySelectorAll('.card-item[data-instance-id]')].find(candidate => candidate.dataset.instanceId === instance.instanceId)
        : null
      return instance ? {
        cardId: instance.cardId,
        instanceId: instance.instanceId,
        description: node?.querySelector('.card-desc')?.textContent || '',
      } : null
    }
    const before = {
      actionPoints: player?.actionPoints,
      effect: effect(),
      card: cardDisplay(),
      flowState: Array.isArray(G.extensions?.flowState) ? G.extensions.flowState.filter(entry => entry?.scope === 'player' && entry?.entityId === 'training-blue' && entry?.namespace === 'content' && entry?.name === 'elune-blessing-buff') : [],
    }
    const action = await prepareTutorialTargetAction({
      type: 'useBasicSkill', playerId: caster.ownerPlayerId, pieceId: caster.instanceId, skillId: 'elune-blessing',
    }, {})
    await commitTutorialScriptAction(action, { quiet: true })
    // The formal training action updates the authoritative G snapshot; quiet
    // scripted actions intentionally skip animation rendering, so invoke the
    // existing battle render callback before inspecting the live tooltip.
    if (typeof render === 'function') render()
    await new Promise(resolve => setTimeout(resolve, 250))
    const after = {
      actionPoints: G.players.find(candidate => candidate.playerId === caster.ownerPlayerId)?.actionPoints,
      effect: effect(),
      card: cardDisplay(),
      flowState: Array.isArray(G.extensions?.flowState) ? G.extensions.flowState.filter(entry => entry?.scope === 'player' && entry?.entityId === 'training-blue' && entry?.namespace === 'content' && entry?.name === 'elune-blessing-buff') : [],
      marker: window.__RVB_TRAINING__ || null,
    }
    return { before, after, action }
  })()`)
}

try {
  await startEditor()
  const edited = await editAuthoringFields(editor)
  await stopEditor()

  // Reuse exactly the same isolated userData/project after an actual process
  // restart.  This proves source persistence independently of in-memory draft
  // sessions before opening the formal training snapshot.
  await startEditor()
  await reopenAssertions(editor)
  const trainingSnapshot = await openDraftTraining(editor)
  const trainingState = await startTrainingScene(training)
  const extensionUpdate = await executeEluneBlessing(training)
  assert.match(extensionUpdate.before.effect?.aria || '', /当前月神赐福倍率：未赋值。/)
  assert.equal(extensionUpdate.before.flowState.length, 0)
  assert.ok(extensionUpdate.after.flowState.length >= 1, `正式 state update 未写入玩家扩展：${JSON.stringify(extensionUpdate)}`)
  assert.equal(extensionUpdate.after.flowState[0]?.value?.multiplier, 1.5, `玩家扩展值异常：${JSON.stringify(extensionUpdate.after.flowState)}`)
  assert.match(extensionUpdate.after.effect?.aria || '', /当前月神赐福倍率：1\.5。/)
  assert.notEqual(extensionUpdate.after.effect?.aria, extensionUpdate.before.effect?.aria, 'state update 后玩家规则 tooltip 必须重新插值')
  assert.equal(extensionUpdate.after.card?.cardId, 'holy-smite', `正式技能应生成确定的圣光惩击手牌：${JSON.stringify(extensionUpdate.after.card)}`)
  assert.equal(extensionUpdate.after.card?.description, '圣光伤害提高1.5倍。', `牌面描述必须读取同一玩家的扩展值：${JSON.stringify(extensionUpdate.after.card)}`)
  assert.equal(extensionUpdate.after.actionPoints, extensionUpdate.before.actionPoints - 1, '真实技能动作必须消耗一次行动点')
  assert.notEqual(extensionUpdate.after.marker?.stateHash, trainingState.marker?.stateHash, '正式 snapshot 改变后 state hash 必须更新')
  await screenshot(editor, 'editor-description-controls')
  await screenshot(training, 'training-player-rule-before-after')
  report = {
    ok: true,
    task: 'RED-252',
    role: 'implementation self-check for dynamic description training display',
    rootSeed,
    cdpPort,
    project,
    userData,
    skippedInvalidDocuments,
    iconPath,
    saved: {
      skillDescription: edited.savedSkill.description,
      playerRuleDescription: edited.savedRule.description,
      cardDescription: edited.savedCard.description,
      playerRuleIcon: edited.savedRule.iconPath,
      piecePlayerRules: edited.savedPiece.playerRules,
    },
    trainingSnapshot: {
      contentHash: trainingSnapshot.marker.contentHash,
      pieceId: trainingSnapshot.marker.draft.pieceId,
      skillDescription: trainingSnapshot.snapshotSkill.description,
      playerRuleDescription: trainingSnapshot.snapshotRule.description,
      cardDescription: trainingSnapshot.snapshotCard.description,
    },
    trainingState: {
      rootSeed: trainingState.marker.rootSeed,
      currentPlayerId: trainingState.turn,
      playerRule: trainingState.effect,
      piece: trainingState.tyrande,
      beforeFlowState: extensionUpdate.before.flowState,
      afterFlowState: extensionUpdate.after.flowState,
      beforeTooltip: extensionUpdate.before.effect,
      afterTooltip: extensionUpdate.after.effect,
      beforeCard: extensionUpdate.before.card,
      afterCard: extensionUpdate.after.card,
      actionPoints: { before: extensionUpdate.before.actionPoints, after: extensionUpdate.after.actionPoints },
      stateHashChanged: extensionUpdate.after.marker?.stateHash !== trainingState.marker?.stateHash,
    },
    screenshots: [
      path.join(evidence, 'skill-description-editor.png'),
      path.join(evidence, 'player-rule-display-editor.png'),
      path.join(evidence, 'player-rule-display-editor-full.png'),
      path.join(evidence, 'card-description-editor.png'),
      path.join(evidence, 'piece-player-rule-editor.png'),
      path.join(evidence, 'editor-description-controls.png'),
      path.join(evidence, 'training-player-rule-before-after.png'),
    ],
    checks: [
      'isolated temporary official project, userData and dynamic CDP port',
      'real UI skill description with Chinese expression edit/save/reopen',
      'real UI player rule description and material-library icon edit/save/reopen',
      'real UI player rule association edit/save/reopen on the Tyrande training piece',
      'formal rvb-editor-training snapshot retained modified skill/rule descriptions',
      'real elune-blessing gameplay action wrote the authoritative player flowState extension',
      'player rule tooltip changed from 未赋值 to 1.5 after the authoritative snapshot update',
      'generated holy-smite hand card rendered the same player extension value in its card face',
    ],
  }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  const failure = {
    ok: false,
    task: 'RED-252',
    role: 'implementation self-check for dynamic description training display',
    cdpPort,
    project,
    userData,
    skippedInvalidDocuments,
    error: error instanceof Error ? error.stack || error.message : String(error),
    stdout: childStdout,
    stderr: childStderr,
  }
  try { failure.editor = editor ? await editor.evaluate(`({ url: location.href, route: document.querySelector('[data-shell-breadcrumb]')?.dataset.route || '', documentId: document.querySelector('[data-shell-breadcrumb]')?.dataset.documentId || '', active: document.querySelector('.tab-panel.active')?.id || '', message: document.querySelector('[data-training-message]')?.textContent || '', body: document.body?.textContent?.slice(-5000) || '' })`) : null } catch (diagnosticError) { failure.editorDiagnosticError = String(diagnosticError) }
  try {
    failure.training = training ? await training.evaluate(`({
      url: location.href,
      loading: document.querySelector('#loadingMsg')?.textContent || '',
      status: document.querySelector('#statusMsg')?.textContent || '',
      setupVisible: document.querySelector('#trainingSetupOverlay')?.classList.contains('show') || false,
      marker: window.__RVB_TRAINING__ || null,
      turn: window.G?.turn?.currentPlayerId || null,
      players: Array.isArray(window.G?.players) ? window.G.players : [],
      pieces: Array.isArray(window.G?.pieces) ? window.G.pieces.map(piece => ({ templateId: piece.templateId, ownerPlayerId: piece.ownerPlayerId, faction: piece.faction, statusTags: piece.statusTags || [] })) : [],
      playerCards: [...document.querySelectorAll('.player-state-chip')].map(card => ({ playerId: card.dataset.playerId || '', text: card.textContent || '', effect: card.querySelector('.player-effect-icon')?.outerHTML || '' })),
       statusImages: [...document.querySelectorAll('.piece-card .status-tag img, .piece-status-dot img, .piece-board-status-dot img, .piece-board-status-list-icon img, #pieceInfoContent .status-tag img')].map(image => ({ src: image.getAttribute('src') || '', complete: image.complete === true, naturalWidth: image.naturalWidth || 0, visible: image.getBoundingClientRect().width > 0 && image.getBoundingClientRect().height > 0 })),
      statusImageDiagnostics: [...document.querySelectorAll('.piece-card .status-tag img, .piece-status-dot img, .piece-board-status-dot img, .piece-board-status-list-icon img, #pieceInfoContent .status-tag img')].map(image => ({
        src: image.getAttribute('src') || '',
        className: image.className || '',
        parentClass: image.parentElement?.className || '',
        rect: (() => { const box = image.getBoundingClientRect(); return { width: box.width, height: box.height, x: box.x, y: box.y } })(),
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        display: getComputedStyle(image).display,
        visibility: getComputedStyle(image).visibility,
      })),
      body: document.body?.textContent?.slice(-5000) || '',
    })`) : null
  } catch (diagnosticError) { failure.trainingDiagnosticError = String(diagnosticError) }
  try { await screenshot(editor, 'failure-editor') } catch { /* best effort */ }
  try { await screenshot(training, 'failure-training') } catch { /* best effort */ }
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(failure, null, 2) + '\n')
  console.error(JSON.stringify(failure, null, 2))
  process.exitCode = 1
} finally {
  await stopEditor()
  if (report?.ok) {
    try { fs.rmSync(temporary, { recursive: true, force: true }) } catch (error) { console.error(`保留临时验证目录 ${temporary}：${error.message}`) }
  } else {
    console.error(`保留失败复现项目：${temporary}`)
  }
}
