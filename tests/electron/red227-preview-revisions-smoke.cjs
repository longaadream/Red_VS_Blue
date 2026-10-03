'use strict'

/*
 * RED-227 candidate smoke. This test drives the production training page with
 * native Electron input. It does not inject replacement board/card DOM and
 * does not mutate G.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const port = Number(process.env.RVB_RED227_PORT || 38728)
const baseUrl = 'http://127.0.0.1:' + port
const evidenceRoot = path.resolve(process.env.RVB_RED227_EVIDENCE_ROOT || path.join(root, 'output', 'RED227'))
const trainingRngSeed = 36871

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}

function stopProcessTree(pid) {
  if (!Number.isInteger(pid)) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10000,
      })
    } catch {}
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
      lastError = new Error('HTTP ' + response.status)
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error('preview did not start at ' + url + ': ' + (lastError || 'timeout'))
}

async function runNodeHarness() {
  let preview = null
  try {
    await waitForHttp(baseUrl + '/battle.html', 1500)
  } catch {
    const tsxEntry = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const previewScript = path.join(root, 'scripts', 'run-tutorial-pages-qa.ts')
    ensure(fs.existsSync(tsxEntry), 'missing tsx runtime: ' + tsxEntry)
    preview = spawn(process.execPath, [tsxEntry, previewScript], {
      cwd: root,
      env: Object.assign({}, process.env, { RVB_QA_PAGES_PORT: String(port) }),
      stdio: 'inherit',
      windowsHide: true,
    })
    await waitForHttp(baseUrl + '/battle.html')
  }

  const electronEntry = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  ensure(fs.existsSync(electronEntry), 'missing Electron executable: ' + electronEntry)
  const childEnv = Object.assign({}, process.env, {
    RVB_RED227_PORT: String(port),
    RVB_RED227_EVIDENCE_ROOT: evidenceRoot,
  })
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(electronEntry, [__filename, '--electron-child'], {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RED-227 Electron smoke timed out after 180 seconds')), 180000)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal) console.error('Electron signal: ' + signal)
      resolve(code == null ? 1 : code)
    })
  })
  stopProcessTree(child.pid)
  stopProcessTree(preview && preview.pid)
  if (exitCode !== 0) process.exitCode = exitCode
}

async function runElectronSmoke() {
  const { app, BrowserWindow } = require('electron')
  app.commandLine.appendSwitch('use-gl', 'swiftshader')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  await app.whenReady()
  fs.mkdirSync(evidenceRoot, { recursive: true })

  const evidence = {
    contract: {
      issue: 'RED-227',
      baseBranch: 'main',
      originMain: 'bc76ce78e9014f50e5ef1ea445895de8979b0ea1',
      setup: {
        firstFaction: 'blue',
        firstTemplateIds: ['el-primo'],
        secondFaction: 'red',
        secondTemplateIds: ['dark-aizen'],
      },
      trainingRngSeed,
    },
    setup: null,
    movement: [],
    unmirrored: null,
    mirror: null,
    formal: null,
    meteor: null,
    mobile: null,
    screenshots: [],
    logs: [],
  }

  const windowOptions = {
    show: true,
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  }
  let win = new BrowserWindow(windowOptions)
  win.focus()
  win.webContents.on('console-message', (_event, level, message) => {
    evidence.logs.push({ level, message: String(message) })
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    evidence.logs.push({ level: 'did-fail-load', message: code + ' ' + description + ' ' + url })
  })

  let debuggerApi = win.webContents.debugger
  let debuggerAttached = false
  const cdp = async (method, params) => {
    if (!debuggerAttached) {
      debuggerApi.attach('1.3')
      debuggerAttached = true
    }
    return debuggerApi.sendCommand(method, params)
  }
  const evaluate = async expression => {
    try {
      return await win.webContents.executeJavaScript(expression, true)
    } catch (error) {
      console.error('RED-227 evaluate failed:', error && error.message || error, String(expression).slice(0, 600))
      throw error
    }
  }
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await evaluate(expression)
      if (value) return value
      await delay(50)
    }
    throw new Error(label + ' timed out: ' + expression)
  }

  const loadBattle = async () => {
    win.setContentSize(1280, 720)
    await win.loadURL(baseUrl + '/battle.html?mode=training&red227=1', {
      extraHeaders: 'Cache-Control: no-cache\n',
    })
    await delay(150)
  }

  const sendMouseMove = point => {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(point.x),
      y: Math.round(point.y),
      movementX: 0,
      movementY: 0,
    })
  }
  const sendMouseDown = point => {
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'left',
      clickCount: 1,
    })
  }
  const sendMouseUp = point => {
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'left',
      clickCount: 1,
    })
  }
  const mouseClick = async point => {
    ensure(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'invalid native point ' + JSON.stringify(point))
    win.focus()
    sendMouseMove(point)
    await delay(80)
    sendMouseDown(point)
    await delay(35)
    sendMouseUp(point)
    await delay(180)
  }
  const mouseHover = async point => {
    ensure(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'invalid native hover point ' + JSON.stringify(point))
    win.focus()
    sendMouseMove(point)
    await delay(380)
  }
  const mouseDrag = async (start, end) => {
    ensure(start && end, 'invalid native drag points')
    win.focus()
    sendMouseMove(start)
    await delay(120)
    sendMouseDown(start)
    await delay(90)
    const mid = { x: start.x + (end.x - start.x) * 0.18, y: start.y + (end.y - start.y) * 0.18 }
    sendMouseMove(mid)
    await delay(90)
    sendMouseMove(end)
    await delay(380)
  }
  const mouseRelease = async point => {
    sendMouseUp(point)
    await delay(550)
  }
  const pressEscape = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    await delay(40)
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await delay(240)
  }
  const screenshot = async name => {
    const file = path.join(evidenceRoot, name)
    fs.writeFileSync(file, (await win.capturePage()).toPNG())
    evidence.screenshots.push(file)
    return file
  }

  const stateExpression = [
    '(() => {',
    "  const auth = typeof G !== 'undefined' && G ? G : null",
    "  const model = typeof currentBattleViewModel !== 'undefined' ? currentBattleViewModel : window.battlePresentation && window.battlePresentation.getModel ? window.battlePresentation.getModel() : null",
    "  const pieceList = state => (state && Array.isArray(state.pieces) ? state.pieces : []).map(piece => ({",
    "    id: piece.instanceId || piece.id || null, templateId: piece.templateId || null, ownerPlayerId: piece.ownerPlayerId || null, faction: piece.faction || null,",
    "    x: piece.x, y: piece.y, currentHp: piece.currentHp, displayCurrentHp: piece.displayCurrentHp,",
    "    statusTags: Array.isArray(piece.statusTags) ? piece.statusTags.map(tag => ({ id: tag.id || null, type: tag.type || null, visible: tag.visible !== false, targetPieceId: tag.targetPieceId || null, opponentPlayerId: tag.opponentPlayerId || null })) : [],",
    "  }))",
    "  const previewFloaters = Array.from(document.querySelectorAll('#floatLayer .dmg-float[data-preview=\"true\"]'))",
    "  const previewModelText = model ? JSON.stringify(model) : ''",
    "  const pending = auth && (auth.pendingTargetSelection || auth.pendingOptionSelection)",
    "  const local = typeof pendingSkill !== 'undefined' && pendingSkill ? { skillId: pendingSkill.skillId || null, previewOrigin: pendingSkill.previewOrigin || null, previewOnly: !!pendingSkill.previewOnly, turnTargetActionType: pendingSkill.turnTargetActionType || null } : null",
    '  return {',
    "    playerId: typeof myPlayerId === 'undefined' ? null : myPlayerId, phase: auth && auth.turn ? auth.turn.phase : null,",
    "    turn: auth && auth.turn ? { currentPlayerId: auth.turn.currentPlayerId || null, turnNumber: auth.turn.turnNumber } : null,",
    "    players: auth && Array.isArray(auth.players) ? auth.players.map(player => ({ playerId: player.playerId, faction: player.faction, actionPoints: player.actionPoints, chargePoints: player.chargePoints })) : [],",
    "    pieces: pieceList(auth), displayPieces: pieceList(model), selectedPieceId: typeof selectedPieceId === 'undefined' ? null : selectedPieceId,",
    "    displayHealth: Array.from(document.querySelectorAll('#hpBarLayer3d .piece-board-summary')).map(node => ({ id: node.dataset.pieceId, hp: node.querySelector('.piece-board-health')?.textContent || '', label: node.getAttribute('aria-label') })),",
    "    pendingSkill: local, targetSubmissionPending: !!(typeof targetSubmissionPending !== 'undefined' && targetSubmissionPending),",
    "    pendingSelection: pending ? { playerId: pending.playerId || null, ownerPlayerId: pending.ownerPlayerId || null, selectionId: pending.selectionId || null, stateRevision: pending.stateRevision, targetType: pending.targetType || null, filter: pending.filter || null, candidates: Array.isArray(pending.candidates) ? pending.candidates : [] } : null,",
    "    previewBadge: (() => { const badge = document.querySelector('.skill-preview-badge'); return badge ? { hidden: !!badge.hidden, text: badge.textContent || '' } : null })(),",
    "    previewFloaters: previewFloaters.map(element => element.textContent || ''),",
    "    visibleFloaters: Array.from(document.querySelectorAll('#floatLayer .dmg-float')).map(element => ({ text: element.textContent || '', preview: element.dataset.preview === 'true' })),",
    "    actionHistoryText: document.getElementById('actionHistoryDock')?.textContent || '',",
    "    modal: (() => { const node = document.getElementById('pieceInfoModal'); return node ? { dock: node.classList.contains('character-dock'), hidden: node.style.display === 'none' } : null })(),",
    "    publicModelLeakingSecret: /aizen-kyoka-secret/.test(previewModelText),",
    "    authoritySecrets: pieceList(auth).flatMap(piece => piece.statusTags.filter(tag => /secret|kyoka/i.test(String(tag.type || '') + ' ' + String(tag.id || '')))),",
    '  }',
    '})()',
  ].join('\n')
  const stateSnapshot = () => evaluate(stateExpression)

  const pointForCell = async (x, y) => {
    const args = Number(x) + ',' + Number(y)
    const value = await evaluate('(() => { const p = battlePresentation && battlePresentation.projectCell(' + args +
      '); return p ? { x: p.clientX, y: p.clientY } : null })()')
    ensure(value, 'could not project cell ' + x + ',' + y)
    return value
  }

  const pointForElement = async (selector, description) => {
    const value = await evaluate('(() => { const node = document.querySelector(' +
      JSON.stringify(selector) +
      '); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height } })()')
    ensure(value && value.width > 0 && value.height > 0, description + ' is not visible: ' + JSON.stringify(value))
    return value
  }

  const configureSetup = async (options = {}) => {
    const firstPiece = options.firstPiece || 'el-primo'
    const secondPiece = options.secondPiece || 'dark-aizen'
    const firstFaction = options.firstFaction || 'blue'
    const secondFaction = options.secondFaction || 'red'
    await waitFor('document.readyState === "complete" && typeof PIECES_BY_ID === "object" && Object.keys(PIECES_BY_ID).length > 0', 30000, 'training content')
    await waitFor('document.getElementById("trainingSetupOverlay")?.classList.contains("show") === true', 30000, 'training setup overlay')
    await evaluate([
      '(() => {',
      "  const setSelect = (id, value) => { const node = document.getElementById(id); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) }",
      "  setSelect('trainingFirstFaction', " + JSON.stringify(firstFaction) + ')',
      "  setSelect('trainingSecondFaction', " + JSON.stringify(secondFaction) + ')',
      '  refreshTrainingSetupPieces()',
      '  return true',
      '})()',
    ].join('\n'))

    const setCheckbox = async (listId, value, label) => {
      // Setup checkboxes are preparation, not the pointer behavior under test.
      // Use their normal DOM activation when a long roster scrolls behind the
      // fixed setup footer; do not repeatedly click stale host coordinates.
      const selected = await evaluate('(() => { const node = document.querySelector(' +
        JSON.stringify('#' + listId + ' input[value="' + value + '"]') +
        '); if (!node) return false; if (!node.checked) node.click(); return node.checked })()')
      ensure(selected, label + ' checkbox did not select')
    }

    const removeOtherChecks = async (listId, keepValue) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const checked = await evaluate('Array.from(document.querySelectorAll(' + JSON.stringify('#' + listId + ' input[type="checkbox"]:checked') + ')).map(node => { const host=node.closest("label") || node; host.scrollIntoView({ block: "center", inline: "nearest" }); const r=host.getBoundingClientRect(); return { value:node.value, x:r.left+r.width/2, y:r.top+r.height/2 } })')
        const extra = checked.find(item => item.value !== keepValue)
        if (!extra) return
        await evaluate('(() => { const node = document.querySelector(' + JSON.stringify('#' + listId + ' input[value="' + extra.value + '"]') + '); if (node && node.checked) node.click(); return !!node && !node.checked })()')
        await delay(80)
      }
      const leftovers = await evaluate('Array.from(document.querySelectorAll(' + JSON.stringify('#' + listId + ' input[type="checkbox"]:checked') + ')).map(node => node.value)')
      ensure(leftovers.length === 1 && leftovers[0] === keepValue, 'unexpected setup checkbox selection: ' + JSON.stringify(leftovers))
    }

    await setCheckbox('trainingFirstPieces', firstPiece, firstPiece)
    await removeOtherChecks('trainingFirstPieces', firstPiece)
    await setCheckbox('trainingSecondPieces', secondPiece, secondPiece)
    await removeOtherChecks('trainingSecondPieces', secondPiece)
    const setupForm = await evaluate('(() => { const config = getTrainingSetupConfig(); return { config, firstFaction: document.getElementById("trainingFirstFaction")?.value, secondFaction: document.getElementById("trainingSecondFaction")?.value, firstChecked: Array.from(document.querySelectorAll("#trainingFirstPieces input[type=checkbox]:checked")).map(node => node.value), secondChecked: Array.from(document.querySelectorAll("#trainingSecondPieces input[type=checkbox]:checked")).map(node => node.value) }; })()')
    evidence.setupForm = setupForm
    console.log('RED-227 setup form:', JSON.stringify(setupForm))
    ensure(setupForm.config && setupForm.config.firstFaction === firstFaction && setupForm.config.secondFaction === secondFaction && JSON.stringify(setupForm.config.firstTemplateIds) === JSON.stringify([firstPiece]) && JSON.stringify(setupForm.config.secondTemplateIds) === JSON.stringify([secondPiece]), 'setup form did not retain requested configuration: ' + JSON.stringify(setupForm))
    await evaluate('(() => { if (!window.GameEngine || typeof window.GameEngine.setRng !== "function" || typeof window.GameEngine.mulberry32 !== "function") throw new Error("browser GameEngine RNG injection is unavailable"); window.GameEngine.setRng(window.GameEngine.mulberry32(' + trainingRngSeed + ')); return true })()')
    await evaluate('document.querySelector(\'#trainingSetupOverlay button[onclick="startTrainingFromSetup()"]\').click()')
  }

  const pieceByTemplate = async templateId => {
    const state = await stateSnapshot()
    return state.pieces.find(piece => piece.templateId === templateId) || null
  }
  const playerById = (state, id) => state.players.find(player => player.playerId === id) || null
  const waitPieceAt = async (templateId, x, y, label) => {
    const id = await waitFor('(() => { const piece = G && G.pieces && G.pieces.find(item => item.templateId === ' +
      JSON.stringify(templateId) + '); return piece && piece.x === ' + Number(x) + ' && piece.y === ' + Number(y) +
      ' ? piece.instanceId : false })()', 30000, label)
    return id
  }

  const selectPieceAt = async (templateId, requireMenu = true) => {
    const state = await stateSnapshot()
    const piece = state.pieces.find(item => item.templateId === templateId)
    ensure(piece && piece.currentHp > 0, 'piece unavailable for selection: ' + templateId + ' ' + JSON.stringify(state.pieces))
    if (state.selectedPieceId !== piece.id) {
      const boardPoint = await pointForCell(piece.x, piece.y)
      const hit = await evaluate('(() => { const point = ' + JSON.stringify(boardPoint) + '; const node = document.elementFromPoint(point.x, point.y); const cell = battlePresentation && battlePresentation.screenToCell ? battlePresentation.screenToCell(point.x, point.y) : null; const board = document.getElementById("boardStage3d"); const r = board && board.getBoundingClientRect(); return { point, cell, hit: node ? { tag: node.tagName, id: node.id || null, cls: node.className || null } : null, board: r ? { left:r.left, top:r.top, right:r.right, bottom:r.bottom } : null }; })()')
      console.log('RED-227 select point:', JSON.stringify({ templateId, piece: { x: piece.x, y: piece.y }, hit }))
      await mouseClick(boardPoint)
      await waitFor('typeof selectedPieceId !== "undefined" && selectedPieceId === ' + JSON.stringify(piece.id), 5000, 'select ' + templateId)
    }
    const menuOpen = await evaluate('document.getElementById("pieceContextMenu")?.classList.contains("is-open") === true')
    if (requireMenu && !menuOpen && !(await evaluate('typeof pendingSkill !== "undefined" && !!pendingSkill'))) {
      // Reopen a dismissed compact menu through native board input. This is
      // needed after a skill card closes the menu while retaining selection.
      const boardPoint = await pointForCell(piece.x, piece.y)
      await mouseClick(boardPoint)
      await mouseClick(boardPoint)
      await waitFor('typeof selectedPieceId !== "undefined" && selectedPieceId === ' + JSON.stringify(piece.id), 5000, 'reselect ' + templateId)
    }
    if (requireMenu) await waitFor('document.getElementById("pieceContextMenu")?.classList.contains("is-open") === true', 5000, templateId + ' context menu')
    return piece
  }

  const openSkill = async (templateId, skillId) => {
    await selectPieceAt(templateId, false)
    const skillSelector = '[data-skill-id="' + skillId + '"]'
    const hasVisibleSkill = await evaluate('(() => { const modal = document.getElementById("pieceInfoModal"); return !!(modal && modal.classList.contains("character-dock") && Array.from(document.querySelectorAll("#pieceInfoContent .pi-skill")).some(node => node.querySelector(' + JSON.stringify(skillSelector) + '))); })()')
    if (!hasVisibleSkill) {
      const info = await pointForElement('#pieceContextMenu .piece-context-info', templateId + ' info button')
      await mouseClick(info)
      await waitFor('document.getElementById("pieceInfoModal")?.classList.contains("character-dock") === true', 5000, 'character dock for ' + templateId)
    }
    const rects = await evaluate('(() => { const row = Array.from(document.querySelectorAll("#pieceInfoContent .pi-skill")).find(node => node.querySelector(' +
      JSON.stringify(skillSelector) +
      ')); if (!row) return null; row.scrollIntoView({ block: "center", inline: "nearest" }); const button = row.querySelector(' + JSON.stringify(skillSelector) +
      '); const description = row.querySelector(".pi-skill-desc") || row; const center = node => { const r=node.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2, width:r.width, height:r.height } }; return { row:center(row), button:center(button), description:center(description), buttonDisabled:!!button.disabled, buttonLabel:button.getAttribute("aria-label") } })()')
    ensure(rects && !rects.buttonDisabled, skillId + ' skill is unavailable: ' + JSON.stringify(rects))
    return rects
  }

  const readResource = async playerId => {
    const state = await stateSnapshot()
    const player = playerById(state, playerId)
    ensure(player, 'missing player resource ' + playerId)
    return player.actionPoints
  }

  const hoverSkillTarget = async (skillId, targetTemplateId) => {
    const rects = await openSkill('el-primo', skillId)
    await mouseHover(rects.button)
    ensure(!(await stateSnapshot()).pendingSkill, 'targeted skill hover entered target mode')
    await mouseClick(rects.button)
    await waitFor('typeof pendingSkill !== "undefined" && pendingSkill && pendingSkill.skillId === ' + JSON.stringify(skillId), 5000, skillId + ' target mode')
    const target = await pieceByTemplate(targetTemplateId)
    ensure(target, 'target piece missing ' + targetTemplateId)
    await mouseHover(await pointForCell(target.x, target.y))
    await waitFor('document.querySelector(".skill-preview-badge")?.hidden === false && document.querySelector(".skill-preview-badge")?.textContent.includes("公开效果预演")', 6000, skillId + ' public preview')
    await waitFor('document.querySelectorAll("#floatLayer .dmg-float[data-preview=true]").length > 0', 6000, skillId + ' preview floaters')
    return { rects, target }
  }

  let smokeFailure = null
  try {
    await loadBattle()
    await configureSetup()
    await waitFor('G && G.turn && G.turn.phase === "action" && battlePresentation && _use3d === true && document.querySelector("#boardStage3d canvas")', 30000, 'training runtime')
    await waitFor('getComputedStyle(document.getElementById("loadingOverlay")).display === "none"', 30000, 'training loading hidden')
    const initial = await stateSnapshot()
    const red = playerById(initial, 'training-red')
    const blue = playerById(initial, 'training-blue')
    const primo = initial.pieces.find(piece => piece.templateId === 'el-primo')
    const aizen = initial.pieces.find(piece => piece.templateId === 'dark-aizen')
    ensure(red && blue && red.faction === 'red' && blue.faction === 'blue', 'training engine seat factions mismatch: ' + JSON.stringify(initial.players))
    ensure(primo && primo.x === 8 && primo.y === 9, 'unexpected el-primo start: ' + JSON.stringify(primo))
    ensure(aizen && aizen.x === 12 && aizen.y === 4, 'unexpected dark-aizen start: ' + JSON.stringify(aizen))
    ensure(primo.ownerPlayerId === 'training-red' && primo.faction === 'red' && aizen.ownerPlayerId === 'training-blue' && aizen.faction === 'blue', 'training piece seat assignment mismatch: ' + JSON.stringify({ primo, aizen }))
    evidence.setup = { initial, screenshot: await screenshot('final-red227-setup.png') }

    const movePath = [[8, 7], [11, 7], [11, 4]]
    for (const [x, y] of movePath) {
      const before = await stateSnapshot()
      const source = before.pieces.find(piece => piece.templateId === 'el-primo')
      ensure(source, 'el-primo disappeared before move')
      await selectPieceAt('el-primo')
      const legal = await evaluate('typeof validMoves !== "undefined" ? Array.from(validMoves) : []')
      ensure(legal.includes(x + ',' + y), 'move path cell is not legal: ' + x + ',' + y + ' legal=' + JSON.stringify(legal))
      await mouseClick(await pointForCell(x, y))
      await waitPieceAt('el-primo', x, y, 'move el-primo to ' + x + ',' + y)
      await delay(350)
      const after = await stateSnapshot()
      evidence.movement.push({
        from: { x: source.x, y: source.y },
        to: { x, y },
        actionPointsBefore: playerById(before, 'training-red')?.actionPoints,
        actionPointsAfter: playerById(after, 'training-red')?.actionPoints,
        selectedPieceId: after.selectedPieceId,
      })
    }
    const afterMove = await stateSnapshot()
    ensure(afterMove.pieces.find(piece => piece.templateId === 'dark-aizen')?.x === 12 && afterMove.pieces.find(piece => piece.templateId === 'dark-aizen')?.y === 4, 'aizen moved unexpectedly')
    evidence.setup.afterMove = afterMove
    evidence.setup.afterMoveScreenshot = await screenshot('final-red227-after-move.png')

    const apBeforePreview = await readResource('training-red')
    const firstPreview = await hoverSkillTarget('el-primo-punch', 'dark-aizen')
    const previewHpExpression = '(() => { const p = G.pieces.find(item => item.templateId === "dark-aizen"); const summary = Array.from(document.querySelectorAll("#hpBarLayer3d .piece-board-summary")).find(node => node.dataset.pieceId === p.instanceId); return p.currentHp === 9 && summary?.querySelector(".piece-board-health")?.textContent === "5" })()'
    await waitFor(previewHpExpression, 6000, 'unmirrored preview HP')
    const unmirroredPreview = await stateSnapshot()
    const unmirroredFloaters = unmirroredPreview.previewFloaters.slice()
    ensure(unmirroredPreview.previewFloaters.length === 4 && unmirroredPreview.previewFloaters.every(text => text === '−1'), 'unmirrored preview floaters mismatch: ' + JSON.stringify(unmirroredPreview.previewFloaters))
    ensure(unmirroredPreview.pendingSkill && unmirroredPreview.pendingSkill.skillId === 'el-primo-punch', 'unmirrored preview lost pending skill')
    ensure(await readResource('training-red') === apBeforePreview, 'unmirrored preview deducted AP')
    const unmirroredShot = await screenshot('final-red227-unmirrored-preview.png')
    const domRoot = (await cdp('DOM.getDocument', { depth: 0 })).root.nodeId
    const rowSelector = '#pieceInfoContent .pi-skill:has([data-skill-id="el-primo-punch"])'
    const rowBeforeCancel = (await cdp('DOM.querySelector', { nodeId: domRoot, selector: rowSelector })).nodeId
    await mouseClick(firstPreview.rects.description)
    await waitFor('typeof pendingSkill !== "undefined" && !pendingSkill && !targetSubmissionPending', 6000, 'whole-card cancellation')
    await delay(350)
    const rowAfterCancel = (await cdp('DOM.querySelector', { nodeId: domRoot, selector: rowSelector })).nodeId
    ensure(rowBeforeCancel > 0 && rowBeforeCancel === rowAfterCancel, 'cancellation replaced the hovered skill row')
    const cancelled = await stateSnapshot()
    ensure(!cancelled.pendingSkill, 'stationary pointer rearmed preview after cancellation')
    ensure(cancelled.pieces.find(piece => piece.templateId === 'dark-aizen')?.currentHp === 9, 'cancel did not restore authoritative HP')
    ensure(cancelled.previewFloaters.length === 0, 'cancel left preview floaters')
    ensure(await readResource('training-red') === apBeforePreview, 'cancel changed AP')
    evidence.unmirrored = {
      point: firstPreview.target,
      before: apBeforePreview,
      preview: unmirroredPreview,
      afterCancel: cancelled,
      screenshot: unmirroredShot,
      ready: unmirroredPreview.previewBadge && unmirroredPreview.previewBadge.text.includes('公开效果预演'),
      reusedRow: rowBeforeCancel === rowAfterCancel,
    }

    const switchPreview = await openSkill('el-primo', 'el-primo-meteor-belt')
    await mouseHover(switchPreview.description)
    await waitFor('typeof pendingSkill !== "undefined" && pendingSkill && pendingSkill.skillId === "el-primo-meteor-belt" && pendingSkill.previewOnly === true', 5000, 'no-target hover switch')
    const switched = await stateSnapshot()
    ensure(await readResource('training-red') === apBeforePreview, 'hover skill switch deducted AP')
    await pressEscape()
    await waitFor('typeof pendingSkill !== "undefined" && !pendingSkill', 5000, 'cancel switched hover')
    const afterSwitchCancel = await stateSnapshot()
    ensure(await readResource('training-red') === apBeforePreview, 'switch cancellation released an action')
    evidence.unmirrored.switch = { before: switched, afterCancel: afterSwitchCancel }

    await mouseClick(await pointForCell(8, 7))
    await delay(220)
    const secondPreviewFlow = await hoverSkillTarget('el-primo-punch', 'dark-aizen')
    const secondPreview = await stateSnapshot()
    ensure(secondPreview.previewFloaters.length === 4, 'repeat unmirrored preview did not render four hits')
    await mouseClick(secondPreviewFlow.rects.description)
    await waitFor('typeof pendingSkill !== "undefined" && !pendingSkill', 5000, 'repeat preview cancel')

    const endBlueButton = await pointForElement('#btnEnd', 'blue end-turn button')
    await mouseClick(endBlueButton)
    await waitFor('G && G.turn && G.turn.phase === "action" && G.turn.currentPlayerId === "training-blue" && myPlayerId === "training-blue"', 30000, 'end blue turn')
    const afterBlueTurn = await stateSnapshot()
    evidence.mirror = { afterBlueTurn }

    const mirrorSkill = await openSkill('dark-aizen', 'aizen-kyoka-suiguetsu')
    await mouseClick(mirrorSkill.button)
    await waitFor('typeof pendingSkill !== "undefined" && pendingSkill && pendingSkill.skillId === "aizen-kyoka-suiguetsu"', 5000, 'mirror target mode')
    await mouseClick(await pointForCell(12, 4))
    await waitFor('G && G.pieces && G.pieces.some(piece => piece.templateId === "dark-aizen" && piece.statusTags && piece.statusTags.some(tag => String(tag.type || "").includes("aizen-kyoka-secret")))', 10000, 'mirror secret armed')
    const mirrorArmed = await stateSnapshot()
    ensure(mirrorArmed.authoritySecrets.length > 0, 'mirror authority secret was not armed')
    ensure(!mirrorArmed.publicModelLeakingSecret, 'mirror secret leaked into the displayed model')
    evidence.mirror.armed = mirrorArmed
    evidence.mirror.armedScreenshot = await screenshot('final-red227-mirror-armed.png')

    await mouseClick(await pointForElement('#btnEnd', 'red end-turn button'))
    await waitFor('G && G.turn && G.turn.phase === "action" && G.turn.currentPlayerId === "training-red" && myPlayerId === "training-red"', 30000, 'end red turn')
    const beforeMirroredPreview = await stateSnapshot()
    const mirroredPreviewSetup = await hoverSkillTarget('el-primo-punch', 'dark-aizen')
    await waitFor(previewHpExpression, 6000, 'mirrored preview HP')
    const mirroredPreview = await stateSnapshot()
    ensure(mirroredPreview.previewFloaters.length === 4 && mirroredPreview.previewFloaters.every(text => text === '−1'), 'mirrored preview floaters mismatch: ' + JSON.stringify(mirroredPreview.previewFloaters))
    ensure(JSON.stringify(mirroredPreview.previewFloaters) === JSON.stringify(unmirroredFloaters), 'mirrored preview floaters differ from unmirrored preview: ' + JSON.stringify({ unmirrored: unmirroredFloaters, mirrored: mirroredPreview.previewFloaters }))
    ensure(await readResource('training-red') === playerById(beforeMirroredPreview, 'training-red')?.actionPoints, 'mirrored preview deducted AP')
    ensure(mirroredPreview.authoritySecrets.length > 0, 'mirror authority secret disappeared during preview')
    ensure(!mirroredPreview.publicModelLeakingSecret, 'mirror secret leaked through public preview')
    ensure(mirroredPreview.previewBadge && mirroredPreview.previewBadge.text.includes('公开效果预演'), 'mirrored preview was not ready')
    const mirroredShot = await screenshot('final-red227-mirrored-preview.png')
    evidence.mirror.preview = { before: beforeMirroredPreview, setup: mirroredPreviewSetup, preview: mirroredPreview, screenshot: mirroredShot }

    await mouseClick(await pointForCell(12, 4))
    await waitFor('G && G.pendingTargetSelection', 12000, 'mirror pending alternate target')
    const pendingMirror = await stateSnapshot()
    ensure(pendingMirror.pendingSelection, 'mirror target selection missing')
    const formalSource = pendingMirror.pieces.find(piece => piece.templateId === 'el-primo')
    ensure(formalSource, 'formal source missing while mirror pending')
    ensure(pendingMirror.pendingSelection.candidates.some(candidate => candidate && candidate.type === 'piece' && candidate.pieceId === formalSource.id), 'mirror alternate candidate did not include el-primo: ' + JSON.stringify(pendingMirror.pendingSelection))
    ensure(!JSON.stringify(pendingMirror.pendingSelection).includes('aizen-kyoka-secret'), 'mirror secret appeared in pending selection payload')
    evidence.formal = { pending: pendingMirror }
    evidence.formal.pendingScreenshot = await screenshot('final-red227-formal-pending.png')

    const formalBefore = await stateSnapshot()
    const sourceBeforeFormal = formalBefore.pieces.find(piece => piece.templateId === 'el-primo')
    const alternatePoint = await pointForCell(sourceBeforeFormal.x, sourceBeforeFormal.y)
    await mouseClick(alternatePoint)
    await waitFor('G && !G.pendingTargetSelection && !targetSubmissionPending && G.pieces.some(piece => piece.templateId === "el-primo" && piece.currentHp < ' + Number(sourceBeforeFormal.currentHp) + ')', 30000, 'formal mirror alternate target')
    const formalAfter = await stateSnapshot()
    const sourceAfterFormal = formalAfter.pieces.find(piece => piece.templateId === 'el-primo')
    const aizenAfterFormal = formalAfter.pieces.find(piece => piece.templateId === 'dark-aizen')
    const redBeforeFormal = playerById(formalBefore, 'training-red')
    const redAfterFormal = playerById(formalAfter, 'training-red')
    ensure(sourceAfterFormal.currentHp === sourceBeforeFormal.currentHp - 4, 'formal alternate target damage mismatch: ' + JSON.stringify({ before: sourceBeforeFormal, after: sourceAfterFormal }))
    ensure(aizenAfterFormal.currentHp === 9, 'formal Aizen HP changed unexpectedly: ' + JSON.stringify(aizenAfterFormal))
    ensure(redAfterFormal.actionPoints === redBeforeFormal.actionPoints - 1, 'formal action did not consume exactly one AP')
    ensure(!formalAfter.actionHistoryText.includes('秘密目标') && !formalAfter.actionHistoryText.includes('aizen-kyoka-secret'), 'formal action history exposed secret target')
    evidence.formal.after = formalAfter
    evidence.formal.screenshot = await screenshot('final-red227-formal-rewrite.png')

    const meteor = await openSkill('el-primo', 'el-primo-meteor-belt')
    const meteorBefore = await stateSnapshot()
    await mouseHover(meteor.description)
    ensure(await evaluate('document.querySelector("#pieceInfoContent .character-cast[data-skill-id=el-primo-meteor-belt]").closest(".pi-skill").classList.contains("ui-motion-hover")'), 'battle skill card has no hover feedback')
    await waitFor('typeof pendingSkill !== "undefined" && pendingSkill && pendingSkill.skillId === "el-primo-meteor-belt" && pendingSkill.previewOnly === true', 5000, 'meteor no-target hover')
    await waitFor('document.querySelector(".skill-preview-badge")?.hidden === false && Array.from(document.querySelectorAll("#hpBarLayer3d .piece-board-summary")).some(node => node.dataset.pieceId === "training-red-1" && node.getAttribute("aria-label").includes("流星腰带"))', 5000, 'meteor card hover immediately shows predicted status')
    ensure(await evaluate('(currentBattleViewModel.legal.targetCells || []).length === 0'), 'no-target hover highlighted the entire board')
    ensure(await evaluate('document.getElementById("targetCancelButton").getBoundingClientRect().width === 0'), 'no-target hover showed cancel frame')
    const meteorHover = await stateSnapshot()
    ensure(playerById(meteorHover, 'training-red')?.actionPoints === playerById(meteorBefore, 'training-red')?.actionPoints, 'meteor hover deducted AP')
    const boardDestination = await pointForCell(11, 4)
    // Hover can insert the existing inline target controls. Measure the
    // current header after that layout change, rather than drag stale bounds.
    const meteorDragStart = await pointForElement('#pieceInfoContent .character-cast[data-skill-id="el-primo-meteor-belt"]', 'meteor drag header')
    await mouseDrag(meteorDragStart, boardDestination)
    const meteorBeforeRelease = await stateSnapshot()
    ensure(playerById(meteorBeforeRelease, 'training-red')?.actionPoints === playerById(meteorBefore, 'training-red')?.actionPoints, 'meteor drag preview deducted AP before release')
    ensure(meteorBeforeRelease.pendingSkill && meteorBeforeRelease.pendingSkill.skillId === 'el-primo-meteor-belt', 'meteor drag lost pending skill before release')
    const meteorDragShot = await screenshot('final-red227-meteor-before-release.png')
    await mouseRelease(boardDestination)
    await waitFor('G && !pendingSkill && G.pieces.some(piece => piece.templateId === "el-primo" && piece.statusTags && piece.statusTags.some(tag => String(tag.type || "").includes("el-primo-meteor-belt")))', 30000, 'meteor release action')
    const meteorAfter = await stateSnapshot()
    ensure(playerById(meteorAfter, 'training-red')?.actionPoints === playerById(meteorBefore, 'training-red')?.actionPoints - 1, 'meteor release did not consume exactly one AP')
    evidence.meteor = { before: meteorBefore, hover: meteorHover, beforeRelease: meteorBeforeRelease, after: meteorAfter, screenshotBeforeRelease: meteorDragShot, screenshot: await screenshot('final-red227-meteor-after-release.png') }

    // Advance through normal turn controls so Fury Punch is available again.
    await mouseClick(await pointForElement('#btnEnd', 'mobile blue turn'))
    await waitFor('G.turn.currentPlayerId === "training-blue" && myPlayerId === "training-blue"', 30000, 'mobile blue turn')
    await mouseClick(await pointForElement('#btnEnd', 'mobile red turn'))
    await waitFor('G.turn.currentPlayerId === "training-red" && myPlayerId === "training-red"', 30000, 'mobile red turn')
    await openSkill('el-primo', 'el-primo-punch')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true })
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await delay(300)
    // The phone landscape layout uses its existing compact skill bar.
    const touchPoint = await pointForElement('#pieceContextMenu .piece-context-skill[data-skill-id="el-primo-punch"]', 'touch fury punch')
    const touchBefore = await stateSnapshot()
    const touchAp = playerById(touchBefore, 'training-red')?.actionPoints
    const touchTap = async point => {
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 227, x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }] })
      await delay(80)
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await delay(300)
    }
    await touchTap(touchPoint)
    await waitFor('pendingSkill && pendingSkill.skillId === "el-primo-punch"', 5000, 'touch skill selects target mode')
    const touchSelected = await stateSnapshot()
    const touchCancel = await pointForElement('#pieceContextMenu .piece-context-skill[data-skill-id="el-primo-punch"]', 'touch cancel skill card')
    await touchTap(touchCancel)
    await waitFor('!pendingSkill', 5000, 'touch skill cancels target mode')
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
    const touchAfter = await stateSnapshot()
    ensure(playerById(touchAfter, 'training-red')?.actionPoints === touchAp, 'touch changed AP')
    evidence.mobile = { viewport: { width: 844, height: 390 }, before: touchBefore, selected: touchSelected, after: touchAfter, point: touchPoint, screenshot: await screenshot('final-red227-mobile-card-cancel.png') }

    // Terrain is a separate scenario with a fresh native window. Reusing a
    // phone-emulated Electron capture/input surface after navigation produced
    // UnknownVizError and lost native clicks despite valid DOM hit tests.
    debuggerApi.detach()
    debuggerAttached = false
    const mobileWindow = win
    win = new BrowserWindow(windowOptions)
    debuggerApi = win.webContents.debugger
    win.webContents.on('console-message', (_event, level, message) => {
      evidence.logs.push({ level, message: String(message) })
    })
    mobileWindow.close()
    win.focus()
    await loadBattle()
    await configureSetup({ firstPiece: 'red-sasuke', secondPiece: 'el-primo', firstFaction: 'red', secondFaction: 'blue' })
    await waitFor('G && G.turn.phase === "action" && battlePresentation && _use3d === true && getComputedStyle(document.getElementById("loadingOverlay")).display === "none"', 30000, 'terrain training runtime')
    const terrainInitial = await stateSnapshot()
    const sasuke = terrainInitial.pieces.find(piece => piece.templateId === 'red-sasuke')
    ensure(sasuke, 'terrain source missing')
    const terrainSkill = await openSkill('red-sasuke', 'sasuke-amaterasu')
    await mouseHover(terrainSkill.description)
    ensure(!(await stateSnapshot()).pendingSkill, 'terrain targeted skill hovered into selection')
    await mouseClick(terrainSkill.button)
    await waitFor('pendingSkill && pendingSkill.skillId === "sasuke-amaterasu"', 5000, 'terrain target mode')
    const terrainCenter = { x: sasuke.x + 2, y: sasuke.y }
    await mouseHover(await pointForCell(terrainCenter.x, terrainCenter.y))
    await waitFor('document.querySelector(".skill-preview-badge")?.hidden === false && document.querySelector(".skill-preview-badge")?.textContent.includes("公开效果预演")', 5000, 'terrain ready preview')
    await waitFor('BattleRenderer3D.getPerformanceDiagnostics().tileEffectCellCount === 9 && BattleRenderer3D.getPerformanceDiagnostics().previewBoardActive', 5000, 'nine terrain effects rendered in preview')
    ensure(await evaluate('!G.extensions?.tileEffects || G.extensions.tileEffects.length === 0'), 'terrain preview mutated authority tiles')
    const terrainAp = playerById(terrainInitial, 'training-red').actionPoints
    ensure(await readResource('training-red') === terrainAp, 'terrain hover spent AP')
    evidence.terrain = { center: terrainCenter, before: terrainInitial, preview: await stateSnapshot(), rendered: await evaluate('BattleRenderer3D.getPerformanceDiagnostics()'), screenshot: await screenshot('final-red227-terrain-preview.png') }
    await pressEscape()
    await waitFor('!pendingSkill', 5000, 'terrain preview cancellation')
    ensure(await evaluate('BattleRenderer3D.getPerformanceDiagnostics().tileEffectCellCount === 0 && !BattleRenderer3D.getPerformanceDiagnostics().previewBoardActive'), 'terrain graphics remained after cancellation')
    evidence.terrain.afterCancel = await stateSnapshot()
    evidence.terrain.cancelScreenshot = await screenshot('final-red227-terrain-cancel.png')
    await mouseClick(await pointForCell(sasuke.x, sasuke.y))
    await waitFor('document.getElementById("pieceInfoModal").style.display === "none"', 5000, 'same piece click closes skill menu')
    await mouseClick(await pointForCell(sasuke.x, sasuke.y))
    await waitFor('document.getElementById("pieceInfoModal").style.display !== "none"', 5000, 'same piece click reopens skill menu')
    const settingsPoint = await pointForElement('#battleSettingsButton', 'battle toolbar hover')
    await mouseHover(settingsPoint)
    ensure(await evaluate('document.getElementById("battleSettingsButton").classList.contains("ui-motion-hover")'), 'battle toolbar has no hover feedback')
    sendMouseDown(settingsPoint)
    await delay(40)
    ensure(await evaluate('document.getElementById("battleSettingsButton").classList.contains("ui-motion-pressed")'), 'battle toolbar has no press feedback')
    sendMouseUp(settingsPoint)
    await waitFor('document.getElementById("battleSettings").open', 5000, 'battle settings open')
    await mouseClick(await pointForElement('[data-close-settings]', 'close battle settings'))
    // Training starts with an empty hand. Advance normally to draw the next
    // player's production hand before checking its real card feedback.
    const nextTurn = await pointForElement('#btnEnd', 'draw real training hand')
    await mouseClick(nextTurn)
    await waitFor('G.turn.currentPlayerId === "training-blue" && myPlayerId === "training-blue" && document.querySelectorAll("#handCards > .card-item").length > 0', 30000, 'real training hand after turn')
    await mouseHover(await pointForElement('#handCards > .card-item:not(.card-disabled)', 'battle hand hover'))
    ensure(await evaluate('Array.from(document.querySelectorAll("#handCards > .card-item")).some(node => node.classList.contains("ui-motion-hover"))'), 'battle hand has no hover feedback')
    ensure(await evaluate('!document.getElementById("battleSettingsButton").classList.contains("ui-motion-hover")'), 'battle toolbar retained stale hover state')
    evidence.motion = { skillCardHover: true, toolbarHover: true, toolbarPress: true, handHover: true, screenshot: await screenshot('final-red227-battle-motion.png') }

    const previousWindow = win
    win = new BrowserWindow({ width: 1440, height: 1000, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    debuggerAttached = false
    debuggerApi = win.webContents.debugger
    win.webContents.on('console-message', (_event, level, message) => evidence.logs.push({ level, message: String(message) }))
    previousWindow.close()
    win.focus()
    await loadBattle()
    await configureSetup({ firstPiece: 'shadow', secondPiece: 'el-primo', firstFaction: 'red', secondFaction: 'blue' })
    await waitFor('G && G.turn.phase === "action" && battlePresentation && _use3d === true && getComputedStyle(document.getElementById("loadingOverlay")).display === "none"', 30000, 'shadow training runtime')
    for (const [x, y] of [[8, 7], [11, 7], [10, 7]]) {
      await selectPieceAt('shadow')
      ensure(await evaluate('Array.from(validMoves).includes(' + JSON.stringify(x + ',' + y) + ')'), 'shadow movement cell unavailable')
      await mouseClick(await pointForCell(x, y))
      await waitPieceAt('shadow', x, y, 'shadow normal movement')
      await delay(350)
    }
    // Set up the on-ray target through the production training placement
    // controls. The default map walls prevent a short ordinary move from the
    // original enemy spawn. No battle state is injected or rewritten.
    await mouseClick(await pointForElement('#trainingToolsToggle', 'training placement tools'))
    await evaluate('(() => { const owner = document.getElementById("placeOwner"); owner.value = "training-blue"; owner.dispatchEvent(new Event("change", { bubbles:true })); const template = document.getElementById("placeTemplate"); template.value = "el-primo"; template.dispatchEvent(new Event("change", { bubbles:true })); return template.value === "el-primo" })()')
    await mouseClick(await pointForElement('#btnPlace', 'place a side-shot target'))
    const enemyLanding = await evaluate('[[13,6],[12,6],[11,6],[13,8],[12,8],[11,8]].find(p => currentBattleViewModel.legal.placementCells.some(c => c.x === p[0] && c.y === p[1]))')
    ensure(enemyLanding, 'no legal enemy side-shot placement cell')
    await mouseClick(await pointForCell(enemyLanding[0], enemyLanding[1]))
    await waitFor('G.pieces.some(piece => piece.templateId === "el-primo" && piece.x === ' + enemyLanding[0] + ' && piece.y === ' + enemyLanding[1] + ')', 10000, 'training target enters side-shot range')
    const shadowBefore = await stateSnapshot()
    const sideEnemy = shadowBefore.pieces.find(piece => piece.templateId === 'el-primo' && piece.x === enemyLanding[0] && piece.y === enemyLanding[1])
    const sideY = enemyLanding[1] < 7 ? 6 : 8
    const shadowAp = playerById(shadowBefore, 'training-red').actionPoints
    const commandCount = await evaluate('window.__RVB_RED50_EVIDENCE__.targetCommands.length')
    const chooseDash = async () => {
      const card = await openSkill('shadow', 'shadow-ride-sweep')
      await mouseClick(card.button)
      await mouseClick(await pointForCell(13, 7))
      await waitFor('pendingSkill?.localChoiceDraft && pendingSkill.preparation?.continuation === true', 5000, 'local shadow side choice')
    }
    await chooseDash()
    ensure(await evaluate('!G.pendingTargetSelection && !G.pendingOptionSelection'), 'local choice reached authority early')
    ensure(await readResource('training-red') === shadowAp, 'local dash spent AP')
    ensure(await evaluate('window.__RVB_RED50_EVIDENCE__.targetCommands.length') === commandCount, 'local dash submitted a command')
    const hoverSide = async () => {
      await mouseHover(await pointForCell(13, sideY))
      await waitFor('document.querySelector(".skill-preview-badge")?.hidden === false && BattleRenderer3D.getPerformanceDiagnostics().presentationPathCount >= 3', 5000, 'shadow final three projectile preview')
    }
    await hoverSide()
    evidence.shadow = { before: shadowBefore, localPreview: await stateSnapshot(), renderer: await evaluate('BattleRenderer3D.getPerformanceDiagnostics()'), screenshot: await screenshot('final-red227-shadow-local-preview.png') }
    const predictedHp = Number(evidence.shadow.localPreview.displayHealth.find(piece => piece.id === sideEnemy.id)?.hp)
    ensure(predictedHp < sideEnemy.currentHp, 'final side-shot preview did not display enemy damage')
    ensure(evidence.shadow.localPreview.pieces.find(piece => piece.id === sideEnemy.id)?.currentHp === sideEnemy.currentHp, 'preview mutated enemy HP')
    ensure(await readResource('training-red') === shadowAp, 'side preview spent AP')
    await pressEscape()
    await waitFor('!pendingSkill && !G.pendingTargetSelection && !G.pendingOptionSelection', 5000, 'shadow local cancellation')
    ensure(await readResource('training-red') === shadowAp, 'cancelled sequence spent AP')
    await chooseDash()
    await hoverSide()
    await mouseClick(await pointForCell(13, sideY))
    await waitFor('!pendingSkill && !G.pendingTargetSelection && !G.pendingOptionSelection && G.pieces.some(p => p.templateId === "shadow" && p.x === 13 && p.y === 7)', 10000, 'shadow batch commit')
    ensure(await readResource('training-red') === shadowAp - 1, 'batch did not charge exactly once')
    ensure(await evaluate('window.__RVB_RED50_EVIDENCE__.targetCommands.length') === commandCount + 1, 'sequence did not use one submission')
    evidence.shadow.afterCommit = await stateSnapshot()
    ensure(evidence.shadow.afterCommit.pieces.find(piece => piece.id === sideEnemy.id)?.currentHp === predictedHp, 'batch damage differs from deterministic preview')
    await waitFor('currentBattleViewModel.pieces.some(piece => piece.templateId === "shadow" && piece.x === 13 && piece.y === 7) && Array.from(document.querySelectorAll("#hpBarLayer3d .piece-board-summary")).some(node => node.dataset.pieceId === ' + JSON.stringify(sideEnemy.id) + ' && node.querySelector(".piece-board-health")?.textContent === ' + JSON.stringify(String(predictedHp)) + ')', 10000, 'settled side-shot display')
    evidence.shadow.settledDisplay = await stateSnapshot()
    evidence.shadow.commitScreenshot = await screenshot('final-red227-shadow-batch-commit.png')

    evidence.results = {
      passed: true,
      desktopTraining: true,
      movementPath: movePath,
      unmirroredPreview: true,
      mirroredPreview: true,
      formalMirrorRewrite: true,
      meteorPreRelease: true,
      meteorSingleRelease: true,
      touchSkillSelectAndCancel: true,
      terrainPreview: true,
      samePieceMenuToggle: true,
      battleMotion: true,
      shadowLocalChoicePreviewAndSingleCommit: true,
    }
    fs.writeFileSync(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence.results, null, 2))
  } catch (error) {
    smokeFailure = error
    console.error('RED-227 Electron smoke failed:', error && error.stack || error)
    evidence.results = { passed: false, error: String(error && error.stack || error) }
    evidence.failureState = await stateSnapshot()
    try { evidence.failureScreenshot = await screenshot('final-red227-failure.png') }
    catch (captureError) { evidence.captureError = String(captureError) }
    fs.writeFileSync(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2))
  } finally {
    try { if (debuggerAttached) debuggerApi.detach() } catch {}
    try { if (!win.isDestroyed()) win.close() } catch {}
    app.exit(smokeFailure ? 1 : 0)
  }
}

if (process.argv.includes('--electron-child')) {
  runElectronSmoke().catch(error => {
    console.error('RED-227 Electron smoke failed:', error && error.stack || error)
    process.exitCode = 1
  })
} else {
  runNodeHarness().catch(error => {
    console.error('RED-227 harness failed:', error && error.stack || error)
    process.exitCode = 1
  })
}
