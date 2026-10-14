import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = path.resolve(process.cwd())
const require = createRequire(import.meta.url)
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const evidence = path.join(root, 'output', 'completion-developer-training-smoke')
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-developer-training-'))
const userData = path.join(temporary, 'user')
const project = createContentProject(temporary, 'official', root)
const skillFile = path.join(project, 'data', 'skills', 'fireball.json')
const sourceBefore = fs.readFileSync(skillFile)
const sourceSkill = JSON.parse(sourceBefore.toString('utf8'))
// The embedded training entry point has no seed control in the UI. 594 is the
// explicit deterministic default in electron-editor/training-preview.ts.
const rootSeed = 594

fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')
fs.mkdirSync(evidence, { recursive: true })

let child
let editor
let training
let startupError
const clients = new Set()
let cdpPort
let lastReport
let childStdout = ''
let childStderr = ''

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function reservePort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    await new Promise(resolve => server.close(resolve))
    // Never attach to the long-running user profile's debugging endpoint.
    if (port !== 62435) return port
  }
  throw new Error('无法分配独立的动态 CDP 端口')
}

async function listTargets() {
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
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
    }
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
          return makeClient(target, socket)
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
  throw new Error(`${label} 启动超时${lastError ? `：${lastError.message}` : ''}`)
}

async function connectEditor() {
  return connectTarget(target => target.url.includes('index.html'), '编辑器窗口')
}

async function connectTrainingAfterRetry(oldHash, oldTargetId) {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    try {
      const targets = await listTargets()
      const candidates = targets.filter(target => target.type === 'page' && target.url.startsWith('rvb-editor-training:') && target.url.includes('/battle.html?mode=training'))
      for (const target of candidates) {
        if (target.id === oldTargetId && candidates.length > 1) continue
        const socket = new WebSocket(target.webSocketDebuggerUrl)
        try {
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', reject, { once: true })
          })
          const client = makeClient(target, socket)
          const marker = await client.evaluate("fetch('./__editor-preview.json').then(response => response.json())")
          if (marker?.contentHash && marker.contentHash !== oldHash) return client
          client.close()
        } catch {
          try { socket.close() } catch { /* best effort */ }
        }
      }
    } catch { /* bounded wait for replacement WebContentsView */ }
    await delay(200)
  }
  throw new Error('应用并重试后未发现加载新草稿快照的训练视图')
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

async function waitUntil(predicate, label, timeout = 120000) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`等待条件超时：${label}${lastError ? `；${lastError.message}` : ''}`)
}

async function waitForDraftPanel(client, timeout = 180000) {
  const deadline = Date.now() + timeout
  let lastState = null
  while (Date.now() < deadline) {
    lastState = await client.evaluate(`(() => ({
      active: document.querySelector('#tab-training')?.classList.contains('active'),
      status: document.querySelector('[data-training-status]')?.textContent || '',
      message: document.querySelector('[data-training-message]')?.textContent || '',
      messageKind: document.querySelector('[data-training-message]')?.className || '',
      previewId: window.__developerTrainingPanel?.getPreviewId?.() || null,
    }))()`)
    if (lastState.status === '草稿试玩中') return lastState
    if (lastState.message && /is-error|失败|错误|缺少|不可用|尚未/.test(lastState.messageKind + lastState.message)) {
      throw new Error(`草稿训练打开失败：${JSON.stringify(lastState)}`)
    }
    await delay(100)
  }
  throw new Error(`等待条件超时：草稿训练面板；最后状态 ${JSON.stringify(lastState)}`)
}

async function waitForTrainingBattle(client, timeout = 180000) {
  const deadline = Date.now() + timeout
  let lastState = null
  while (Date.now() < deadline) {
    lastState = await client.evaluate(`(() => ({
      marker: window.__RVB_TRAINING__ || null,
      pieceCount: Array.isArray(G?.pieces) ? G.pieces.length : 0,
      loading: document.querySelector('#loadingMsg')?.textContent || '',
      loadingDisplay: document.querySelector('#loadingOverlay')?.style.display || '',
      setupVisible: document.querySelector('#trainingSetupOverlay')?.classList.contains('show') || false,
      status: document.querySelector('#statusMsg')?.textContent || '',
    }))()`)
    if (lastState.marker?.initialStateHash && lastState.pieceCount === 2 && !lastState.setupVisible) return lastState
    if (/初始化失败|资源读取异常|训练棋子资源未加载/.test(lastState.loading + lastState.status)) {
      throw new Error(`训练营初始化失败：${JSON.stringify(lastState)}`)
    }
    await delay(100)
  }
  throw new Error(`等待条件超时：训练营初始战场；最后状态 ${JSON.stringify(lastState)}`)
}

async function screenshot(client, name) {
  if (!client) return null
  try {
    const result = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const file = path.join(evidence, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  } catch {
    return null
  }
}

async function screenshotElement(client, name, selector) {
  if (!client) return null
  const clip = await client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: rect.width,
      height: rect.height,
    }
  })()`)
  assert.ok(clip, `训练控件截图节点缺失或不可见：${selector}`)
  const result = await client.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { ...clip, scale: 1 },
  })
  const file = path.join(evidence, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  return file
}

async function trainingState(client) {
  return client.evaluate(`(() => ({
    marker: window.__RVB_TRAINING__ || null,
    // The full battle-state hash intentionally includes the pinned profile
    // identity. A draft edit must change that identity, so keep a gameplay
    // projection for the retry assertion that excludes only protocol/debug
    // metadata while retaining every scene/player/turn field.
    scene: (() => {
      const state = JSON.parse(JSON.stringify(G))
      if (state && state.extensions) {
        delete state.extensions.debugBattle
        delete state.extensions.battleProfile
      }
      // Static definitions are supplied by the candidate snapshot. They are
      // expected to differ after editing fireball; the live board/player/turn
      // state above them must remain identical on retry.
      if (state) {
        delete state.pieceStatsByTemplateId
        delete state.skillsById
        delete state.customCards
      }
      return state
    })(),
    pieces: Array.isArray(G?.pieces) ? G.pieces.map(piece => ({
      instanceId: piece.instanceId,
      templateId: piece.templateId,
      ownerPlayerId: piece.ownerPlayerId,
      faction: piece.faction,
      x: piece.x,
      y: piece.y,
      currentHp: piece.currentHp,
      maxHp: piece.maxHp,
    })) : [],
    turn: G?.turn ? {
      currentPlayerId: G.turn.currentPlayerId,
      phase: G.turn.phase,
      turnNumber: G.turn.turnNumber,
    } : null,
    players: Array.isArray(G?.players) ? G.players.map(player => ({
      playerId: player.playerId,
      faction: player.faction,
      actionPoints: player.actionPoints,
      maxActionPoints: player.maxActionPoints,
    })) : [],
    hud: {
      turnBadge: document.querySelector('#turnBadge')?.textContent || '',
      status: document.querySelector('#statusMsg')?.textContent || '',
      log: document.querySelector('#logBody')?.textContent || '',
      playerCards: [...document.querySelectorAll('.player-state-chip')].map(node => ({
        playerId: node.getAttribute('data-player-id'),
        name: node.querySelector('.player-display-name')?.textContent || '',
        side: node.querySelector('.player-side-name')?.textContent || '',
      })),
    },
  }))()`)
}

async function trainingPanelGeometry(client) {
  return client.evaluate(`(() => {
    const rect = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const value = node.getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height }
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      host: rect('#developer-training-host'),
      panel: rect('#developer-training-host .training-panel'),
      stage: rect('#developer-training-host [data-training-stage]'),
      canvas: rect('#developer-training-host [data-training-canvas]'),
    }
  })()`)
}

function assertTrainingPanelGeometry(geometry, label) {
  assert.ok(geometry.host && geometry.panel && geometry.stage && geometry.canvas, `${label}训练营布局节点缺失`)
  assert.ok(geometry.canvas.width > (geometry.viewport.width >= 1400 ? 600 : geometry.stage.width / 2), `${label}原生战场区域过窄：${JSON.stringify(geometry)}`)
  assert.ok(geometry.canvas.height >= geometry.stage.height - 4, `${label}原生战场区域未填满高度：${JSON.stringify(geometry)}`)
  return geometry
}

async function openDraftFromSkillEditor(client) {
  await waitFor(client, "document.readyState === 'complete' && Boolean(document.querySelector('#skills-list'))", '能力组列表')
  await client.evaluate("document.querySelector('[data-tab=skills]').click()")
  await waitFor(client, "Boolean(document.querySelector('#skills-list [data-entity-id=fireball]'))", '火球术能力组')
  await client.evaluate("document.querySelector('#skills-list [data-entity-id=fireball]').click()")
  await waitFor(client, "Boolean(document.querySelector('#skills-detail [data-sentence-trial]'))", '技能试用按钮')
  await client.evaluate(`(() => {
    const side = document.querySelector('[data-training-side]')
    if (!side) throw new Error('训练营控制方选择器缺失')
    side.value = 'training-blue'
    side.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector('#skills-detail [data-sentence-trial]').click()
  })()`)
}

async function configureTrainingScene(client) {
  await waitFor(client, "document.querySelector('#trainingSetupOverlay')?.classList.contains('show')", '训练营设置层')
  const selected = await client.evaluate(`(() => {
    const firstFaction = document.querySelector('#trainingFirstFaction')
    const secondFaction = document.querySelector('#trainingSecondFaction')
    if (!firstFaction || !secondFaction) throw new Error('训练营阵营选择器缺失')
    firstFaction.value = 'blue'
    secondFaction.value = 'red'
    refreshTrainingSetupPieces()
    const choose = (selector, value) => {
      const inputs = [...document.querySelectorAll(selector)]
      const input = inputs.find(candidate => candidate.value === value)
      if (!input) throw new Error('训练营棋子选项缺失：' + value)
      inputs.forEach(candidate => { candidate.checked = candidate === input })
    }
    choose('#trainingFirstPieces input', 'jaina')
    choose('#trainingSecondPieces input', 'dark-akaza')
    return {
      firstFaction: firstFaction.value,
      secondFaction: secondFaction.value,
      firstTemplateIds: [...document.querySelectorAll('#trainingFirstPieces input:checked')].map(input => input.value),
      secondTemplateIds: [...document.querySelectorAll('#trainingSecondPieces input:checked')].map(input => input.value),
    }
  })()`)
  assert.deepEqual(selected.firstTemplateIds, ['jaina'])
  assert.deepEqual(selected.secondTemplateIds, ['dark-akaza'])
  await client.evaluate("document.querySelector('#trainingSetupOverlay button[onclick=\"startTrainingFromSetup()\"]').click()")
  await waitForTrainingBattle(client)
  const initial = await trainingState(client)
  assert.equal(initial.marker.rootSeed, rootSeed)
  assert.equal(initial.marker.setupConfig.firstPlayerId, 'training-blue')
  assert.deepEqual(initial.marker.setupConfig.firstTemplateIds, ['jaina'])
  assert.deepEqual(initial.marker.setupConfig.secondTemplateIds, ['dark-akaza'])
  assert.equal(initial.turn?.currentPlayerId, 'training-blue', '权威回合先手必须是设置的 training-blue 玩家')
  assert.equal(initial.players.find(player => player.playerId === 'training-blue')?.faction, 'blue', '先手玩家阵营必须与蓝方设置一致')
  assert.equal(initial.players.find(player => player.playerId === 'training-blue')?.actionPoints, 10, '先手玩家必须获得行动点')
  assert.equal(initial.players.find(player => player.playerId === 'training-red')?.faction, 'red', '后手玩家阵营必须与红方设置一致')
  assert.equal(initial.players.find(player => player.playerId === 'training-red')?.actionPoints, 0, '后手玩家不能在初始场景获得行动点')
  assert.ok(initial.pieces.some(piece => piece.templateId === 'jaina' && piece.ownerPlayerId === 'training-blue' && piece.faction === 'blue'), 'Jaina 必须归属于设置的蓝方先手玩家')
  assert.ok(initial.pieces.some(piece => piece.templateId === 'dark-akaza' && piece.ownerPlayerId === 'training-red' && piece.faction === 'red'), 'Dark Akaza 必须归属于设置的红方后手玩家')
  assert.match(initial.hud.turnBadge, /蓝方/, '战场 HUD 必须显示所选蓝方先手')
  assert.match(initial.hud.log, /光 先手/, '训练日志必须显示所选蓝方先手')
  assert.deepEqual(initial.hud.playerCards.sort((left, right) => left.playerId.localeCompare(right.playerId)), [
    { playerId: 'training-blue', name: '蓝方', side: '蓝方 · 先手' },
    { playerId: 'training-red', name: '红方', side: '红方 · 后手' },
  ], '玩家卡片的先手/后手标签必须遵循 setup.firstPlayerId')
  const profileIdentity = await client.evaluate("fetch('./__training-profile.json').then(response => { if (!response.ok) throw new Error('训练资源身份缺失'); return response.json() })")
  assert.equal(profileIdentity.schemaVersion, 'rvb-game-profile-identity/v1')
  assert.equal(profileIdentity.engineAbi, 'rvb-engine/v1')
  assert.equal(typeof profileIdentity.runnerRevision, 'string')
  assert.match(profileIdentity.resolvedProfileHash, /^[a-f0-9]{64}$/)
  assert.match(profileIdentity.authorityContentHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(await client.evaluate("G?.extensions?.battleProfile?.profileIdentity || null"), profileIdentity, '训练战局必须钉住快照 profile identity')
  return { ...initial, profileIdentity }
}

async function placeCloseTrainingPieces(client, state) {
  const caster = state.pieces.find(piece => piece.templateId === 'jaina')
  const target = state.pieces.find(piece => piece.templateId === 'dark-akaza')
  assert.ok(caster && target, '训练场必须生成火球术持有者和目标')
  const result = await client.evaluate(`(async() => {
    if (typeof sendPatch !== 'function') throw new Error('训练营场景设置 API 缺失')
    const remove = async instanceId => {
      if (!await sendPatch({ type: 'removePiece', instanceId })) throw new Error('移除默认棋子失败：' + instanceId)
    }
    await remove(${JSON.stringify(caster.instanceId)})
    await remove(${JSON.stringify(target.instanceId)})
    if (!await sendPatch({ type: 'addPiece', ownerPlayerId: ${JSON.stringify(caster.ownerPlayerId)}, templateId: 'jaina', x: 1, y: 1, instanceId: 'training-draft-caster' })) throw new Error('放置施法棋子失败')
    if (!await sendPatch({ type: 'addPiece', ownerPlayerId: ${JSON.stringify(target.ownerPlayerId)}, templateId: 'dark-akaza', x: 2, y: 1, instanceId: 'training-draft-target' })) throw new Error('放置目标棋子失败')
    return window.__RVB_TRAINING__
  })()`)
  assert.equal(result.rootSeed, rootSeed)
  assert.equal(result.setupLog.length, 4, '场景布置必须记录四个权威 PATCH')
  const placed = await trainingState(client)
  assert.deepEqual(placed.pieces.map(piece => [piece.instanceId, piece.templateId, piece.x, piece.y]).sort(), [
    ['training-draft-caster', 'jaina', 1, 1],
    ['training-draft-target', 'dark-akaza', 2, 1],
  ])
  return placed
}

async function runFireball(client) {
  return client.evaluate(`(async() => {
    const caster = G.pieces.find(piece => piece.instanceId === 'training-draft-caster')
    const target = G.pieces.find(piece => piece.instanceId === 'training-draft-target')
    if (!caster || !target) throw new Error('火球术动作前棋子缺失')
    const before = { hp: target.currentHp, actionPoints: G.players.find(player => player.playerId === caster.ownerPlayerId)?.actionPoints }
    const action = await prepareTutorialTargetAction({
      type: 'useBasicSkill', playerId: caster.ownerPlayerId, pieceId: caster.instanceId, skillId: 'fireball',
    }, { targetPieceId: target.instanceId })
    await commitTutorialScriptAction(action, { quiet: true })
    const after = G.pieces.find(piece => piece.instanceId === 'training-draft-target')
    if (!after) throw new Error('火球术动作后目标棋子缺失')
    return {
      before,
      after: { hp: after.currentHp, actionPoints: G.players.find(player => player.playerId === caster.ownerPlayerId)?.actionPoints },
      action,
      marker: window.__RVB_TRAINING__,
    }
  })()`)
}

async function editDraftPowerMultiplier(client) {
  const result = await client.evaluate(`(() => {
    const detail = document.querySelector('#skills-detail')
    const jsonMode = detail?.querySelector('[data-editor-mode=json]')
    if (!detail || !jsonMode) throw new Error('技能 JSON 编辑入口缺失')
    jsonMode.click()
    const source = detail.querySelector('[data-json-source]')
    if (!source) throw new Error('技能 JSON 编辑器缺失')
    const value = JSON.parse(source.value)
    const previous = value.powerMultiplier
    value.powerMultiplier = 2.5
    value.description = '选择敌人（5），造成2.5倍伤害。'
    source.value = JSON.stringify(value, null, 2)
    source.dispatchEvent(new Event('input', { bubbles: true }))
    return {
      previous,
      current: JSON.parse(source.value).powerMultiplier,
      catalog: window.__editorGetContentCatalog?.().skills?.fireball?.powerMultiplier,
      dirty: document.querySelector('#skills-detail [data-footer-state]')?.textContent || '',
    }
  })()`)
  assert.equal(result.previous, sourceSkill.powerMultiplier)
  assert.equal(result.current, 2.5)
  assert.equal(result.catalog, 2.5, '未保存草稿必须进入当前训练请求')
  assert.match(result.dirty, /未保存|草稿/)
  assert.deepEqual(fs.readFileSync(skillFile), sourceBefore, '修改草稿不能直接写入源文件')
  return result
}

try {
  cdpPort = await reservePort()
  assert.notEqual(cdpPort, 62435, '测试不能连接用户 62435 调试端口')
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
  child.stdout?.on('data', chunk => { childStdout = (childStdout + String(chunk)).slice(-8000) })
  child.stderr?.on('data', chunk => { childStderr = (childStderr + String(chunk)).slice(-12000) })
  child.on('error', error => { startupError = error })

  editor = await connectEditor()
  await waitFor(editor, "document.readyState === 'complete'", '编辑器加载')
  await openDraftFromSkillEditor(editor)
  await waitForDraftPanel(editor)
  training = await connectTarget(target => target.url.startsWith('rvb-editor-training:') && target.url.includes('/battle.html?mode=training'), '草稿训练视图')
  await waitFor(training, "document.querySelector('#trainingSetupOverlay')?.classList.contains('show')", '训练营设置界面')
  const marker = await training.evaluate("fetch('./__editor-preview.json').then(response => response.json())")
  assert.equal(marker.acceptedOnly, false)
  assert.equal(marker.draft.skillId, 'fireball')
  assert.equal(marker.draft.pieceId, 'jaina')
  assert.equal(await training.evaluate("typeof editorAPI + ':' + typeof electronAPI"), 'undefined:undefined')
  const initial = await configureTrainingScene(training)
  await screenshot(training, 'setup')
  const placed = await placeCloseTrainingPieces(training, initial)
  await screenshot(training, 'battle-before-action')

  const firstCombat = await runFireball(training)
  assert.equal(firstCombat.before.hp - firstCombat.after.hp, 6, '初始火球术应按 1.5 倍攻击力造成 6 点伤害')
  assert.equal(firstCombat.after.hp, 10)
  const previewId = await editor.evaluate('window.__developerTrainingPanel.getPreviewId()')
  assert.ok(previewId)
  const firstInspect = await editor.evaluate(`window.editorAPI.trainingPreviewInspect(${JSON.stringify(previewId)})`)
  assert.ok(firstInspect)
  assert.equal(firstInspect.rootSeed, rootSeed)
  assert.ok(firstInspect.actionLog.some(entry => entry.command?.type === 'useBasicSkill' || entry.action?.type === 'useBasicSkill' || entry.type === 'useBasicSkill'))
  await waitFor(editor, `(document.querySelector('[data-training-log]')?.textContent || '').includes(${JSON.stringify(`种子 ${rootSeed}`)})`, '面板显示权威动作日志')
  const oldPanelLog = await editor.evaluate("document.querySelector('[data-training-log]')?.textContent || ''")
  assert.ok(oldPanelLog.includes(`种子 ${rootSeed}`))
  const oldLogLine = oldPanelLog.split('\n').find(line => line.includes(`种子 ${rootSeed}`)) || oldPanelLog
  const initialPanelGeometry = assertTrainingPanelGeometry(await trainingPanelGeometry(editor), '首次试玩')
  await screenshot(editor, 'panel-geometry')
  const trainingControlsScreenshot = await screenshotElement(editor, 'training-controls', '#developer-training-host .training-panel__controls')
  await screenshot(editor, 'battle-before-retry')

  await editor.evaluate("document.querySelector('[data-tab=skills]').click()")
  await waitFor(editor, "document.querySelector('#tab-skills')?.classList.contains('active') && Boolean(document.querySelector('#skills-detail [data-json-source]'))", '切到技能编辑页并隐藏训练视图')
  assert.equal(await editor.evaluate("document.querySelector('#tab-training')?.classList.contains('active')"), false)
  assert.equal(await editor.evaluate('window.__developerTrainingPanel.getPreviewId()'), previewId, '切换编辑页不能关闭训练会话')
  assert.ok(await editor.evaluate(`window.editorAPI.trainingPreviewInspect(${JSON.stringify(previewId)})`), '隐藏时训练视图仍应保留会话')
  await screenshot(editor, 'editor-hidden')

  await editDraftPowerMultiplier(editor)
  await editor.evaluate("document.querySelector('[data-tab=training]').click()")
  await waitFor(editor, "document.querySelector('#tab-training')?.classList.contains('active') && document.querySelector('[data-training-retry]')?.disabled === false", '返回训练面板')
  const oldTrainingTargetId = training.targetId
  const oldContentHash = firstInspect.contentHash
  training.close()
  training = null
  await editor.evaluate("document.querySelector('[data-training-retry]').click()")
  await waitFor(editor, "(document.querySelector('[data-training-message]')?.textContent || '').includes('相同初始场景')", '应用草稿并重试反馈', 180000)
  training = await connectTrainingAfterRetry(oldContentHash, oldTrainingTargetId)
  await waitFor(training, "Boolean(window.__RVB_TRAINING__?.initialStateHash) && Boolean(G?.pieces?.find(piece => piece.instanceId === 'training-draft-target'))", '重试后的相同初始场景')
  const retried = await trainingState(training)
  assert.equal(retried.marker.rootSeed, rootSeed)
  assert.deepEqual(retried.marker.setupConfig, placed.marker.setupConfig)
  assert.notEqual(retried.marker.initialStateHash, placed.marker.initialStateHash, '草稿内容变化必须更新钉住的 profile identity 哈希')
  assert.equal(retried.marker.initialStateHash, retried.marker.stateHash, '重试后的初始场景不应包含旧实战动作')
  assert.deepEqual(retried.scene, placed.scene, '重试必须恢复相同的实际棋盘、玩家与回合场景')
  assert.equal(retried.marker.setupLog.length, placed.marker.setupLog.length)
  const normalizeSetupLog = log => log.map(entry => ({
    initial: entry.initial,
    type: entry.type,
    input: entry.input,
  }))
  assert.deepEqual(normalizeSetupLog(retried.marker.setupLog), normalizeSetupLog(placed.marker.setupLog), '重试必须重放相同的权威场景 PATCH 输入')
  assert.equal(retried.marker.actionLog.some(entry => entry.command?.type === 'useBasicSkill' || entry.action?.type === 'useBasicSkill' || entry.type === 'useBasicSkill'), false, '重试不得重放旧实战动作')
  await waitFor(editor, `([...document.querySelectorAll('[data-training-history] pre')].some(node => (node.textContent || '').includes(${JSON.stringify(oldLogLine)})))`, '重试后保留旧日志')
  const retriedInspect = await editor.evaluate(`window.editorAPI.trainingPreviewInspect(${JSON.stringify(previewId)})`)
  assert.ok(retriedInspect)
  assert.notEqual(retriedInspect.contentHash, oldContentHash)
  const retriedPanelGeometry = assertTrainingPanelGeometry(await trainingPanelGeometry(editor), '重试后')
  await screenshot(training, 'battle-after-retry')
  await screenshot(editor, 'panel-after-retry')

  const retriedCombat = await runFireball(training)
  assert.equal(retriedCombat.before.hp, 16, '重试后的目标应从相同生命状态开始')
  assert.equal(retriedCombat.before.hp - retriedCombat.after.hp, 10, '修改后的火球术应按 2.5 倍攻击力造成 10 点伤害')
  assert.equal(retriedCombat.after.hp, 6)
  assert.deepEqual(fs.readFileSync(skillFile), sourceBefore, '草稿试用不能覆盖源文件')
  await waitFor(editor, `(document.querySelector('[data-training-log]')?.textContent || '').includes(${JSON.stringify(`种子 ${rootSeed}`)})`, '重试后日志刷新')

  await editor.evaluate("document.querySelector('[data-training-close]').click()")
  await waitFor(editor, "document.querySelector('[data-training-status]')?.textContent === '未打开' && window.__developerTrainingPanel?.getPreviewId() === null", '关闭训练营并清理原生视图')
  await waitUntil(async () => {
    try { return !(await listTargets()).some(target => target.type === 'page' && target.url.startsWith('rvb-editor-training:')) }
    catch { return false }
  }, '训练视图目标清理')
  assert.equal(await editor.evaluate(`window.editorAPI.trainingPreviewInspect(${JSON.stringify(previewId)})`), null)
  if (fs.existsSync(path.join(userData, 'training-previews'))) assert.deepEqual(fs.readdirSync(path.join(userData, 'training-previews')), [])
  await screenshot(editor, 'closed')

  lastReport = {
    ok: true,
    task: 'RED-252',
    role: 'implementation self-check for embedded developer-training',
    rootSeed,
    cdpPort,
    project,
    userData,
    previewId,
    initialContentHash: oldContentHash,
    retriedContentHash: retriedInspect.contentHash,
    initialStateHash: placed.marker.initialStateHash,
    retriedStateHash: retried.marker.stateHash,
    gameplaySceneEqual: true,
    panelGeometry: { initial: initialPanelGeometry, retried: retriedPanelGeometry },
    trainingControlsScreenshot,
    initialAuthority: {
      turn: placed.turn,
      players: placed.players,
      pieces: placed.pieces.map(piece => ({
        instanceId: piece.instanceId,
        templateId: piece.templateId,
        ownerPlayerId: piece.ownerPlayerId,
        faction: piece.faction,
      })),
      hud: placed.hud,
    },
    initialAction: { before: firstCombat.before, after: firstCombat.after, delta: firstCombat.before.hp - firstCombat.after.hp },
    retriedAction: { before: retriedCombat.before, after: retriedCombat.after, delta: retriedCombat.before.hp - retriedCombat.after.hp },
    checks: [
      'isolated temporary project, userData and dynamic CDP port',
      'real skill editor trial opens one draft fireball in an embedded native WebContentsView',
      'fixed root seed, currentPlayerId, player faction, piece faction and owner are visible in authoritative training metadata',
      'the native HUD, player cards and training log display the selected blue first player',
      'the controls-only renderer screenshot is kept separate from the native battle screenshot',
      'real setup PATCHes are recorded and replayed without replaying the old combat action',
      'switching to the skill editor hides the native view while keeping its session alive',
      'unsaved draft change reaches apply-and-retry and changes authoritative damage from 6 to 10',
      'retry restores the same gameplay setup scene while the changed draft updates the profile-pinned state hash and preserves the old action log in the panel',
      'closing removes the preview target and inspect returns null',
    ],
  }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(lastReport, null, 2) + '\n')
  console.log(JSON.stringify(lastReport))
} catch (error) {
  const failure = {
    ok: false,
    task: 'RED-252',
    role: 'implementation self-check for embedded developer-training',
    cdpPort,
    project,
    userData,
    error: error instanceof Error ? error.stack || error.message : String(error),
    stdout: childStdout,
    stderr: childStderr,
  }
  try { failure.editor = editor ? await editor.evaluate(`({ url: location.href, active: document.querySelector('.tab-panel.active')?.id, status: document.querySelector('[data-training-status]')?.textContent, message: document.querySelector('[data-training-message]')?.textContent, toast: document.querySelector('#toast')?.textContent, body: document.body.textContent.slice(-8000), log: document.querySelector('[data-training-log]')?.textContent })`) : null } catch (diagnosticError) { failure.editorDiagnosticError = String(diagnosticError) }
  try {
    failure.training = training ? await trainingState(training) : null
    failure.trainingPage = training ? await training.evaluate(`(async () => ({
      title: document.title,
      ready: document.readyState,
      loading: document.querySelector('#loadingMsg')?.textContent || '',
      loadingDisplay: document.querySelector('#loadingOverlay')?.style.display || '',
      setupVisible: document.querySelector('#trainingSetupOverlay')?.classList.contains('show') || false,
      status: document.querySelector('#statusMsg')?.textContent || '',
      origin: location.origin,
      crossOriginIsolated: Boolean(window.crossOriginIsolated),
      sharedArrayBuffer: typeof SharedArrayBuffer,
      responseIsolationHeaders: await fetch(location.href, { cache: 'no-store' }).then(response => ({
        coop: response.headers.get('cross-origin-opener-policy'),
        coep: response.headers.get('cross-origin-embedder-policy'),
      })).catch(error => ({ error: String(error) })),
      gameEngine: typeof window.GameEngine,
      gameEngineKeys: window.GameEngine ? Object.keys(window.GameEngine).slice(0, 20) : [],
      runtime: typeof window.RvBGameEngine,
      battleDataLoad: window.__RVB_BATTLE_DATA_LOAD__ || null,
      engineFetch: await fetch('./js/game-engine.js').then(async response => {
        const text = await response.text()
        return { ok: response.ok, status: response.status, length: text.length, head: text.slice(0, 80), tail: text.slice(-120) }
      }).catch(error => ({ error: String(error) })),
      engineEval: await fetch('./js/game-engine.js').then(response => response.text()).then(text => {
        try {
          new Function(text)()
          return { ok: true, gameEngine: typeof window.GameEngine }
        } catch (error) {
          return { ok: false, error: String(error?.stack || error) }
        }
      }).catch(error => ({ ok: false, error: String(error?.stack || error) })),
      scripts: [...document.scripts].map(script => ({ src: script.src, readyState: script.readyState })),
      body: document.body.textContent.slice(-5000),
    }))()`) : null
  } catch (diagnosticError) { failure.trainingDiagnosticError = String(diagnosticError) }
  try { failure.targets = await listTargets() } catch (diagnosticError) { failure.targetDiagnosticError = String(diagnosticError) }
  await screenshot(editor, 'failure-editor')
  await screenshot(training, 'failure-training')
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(failure, null, 2) + '\n')
  console.error(JSON.stringify(failure, null, 2))
  process.exitCode = 1
} finally {
  for (const client of clients) client.close()
  if (child && !child.killed) child.kill()
  await delay(500)
  if (lastReport?.ok) {
    try { fs.rmSync(temporary, { recursive: true, force: true }) } catch (error) { console.error(`保留临时验证目录 ${temporary}：${error.message}`) }
  } else {
    console.error(`保留失败复现项目：${temporary}`)
  }
}
