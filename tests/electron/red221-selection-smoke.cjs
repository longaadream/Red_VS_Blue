const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const scriptPath = __filename
const defaultRoot = path.resolve(__dirname, '../..')
const root = path.resolve(process.env.RVB_SOURCE_ROOT || defaultRoot)
const evidenceRoot = path.resolve(
  process.env.RVB_EVIDENCE_ROOT || path.join(defaultRoot, 'output', 'RED-221', 'browser'),
)
const port = Number(process.env.RVB_RED221_PORT || 38721)
const baseUrl = `http://127.0.0.1:${port}`
const isElectronChild = Boolean(process.versions.electron)

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function ensure(condition, message) {
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
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`Local tutorial preview did not start at ${url}: ${lastError || 'timeout'}`)
}

async function runNodeHarness() {
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const env = {
    ...process.env,
    RVB_RED221_PORT: String(port),
    RVB_QA_PAGES_PORT: String(port),
    RVB_SOURCE_ROOT: root,
    RVB_EVIDENCE_ROOT: evidenceRoot,
  }
  const tsxEntry = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const previewScript = path.join(root, 'scripts', 'run-tutorial-pages-qa.ts')
  const electronEntry = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  ensure(fs.existsSync(tsxEntry), `Missing tsx runtime: ${tsxEntry}`)
  ensure(fs.existsSync(previewScript), `Missing tutorial preview script: ${previewScript}`)
  ensure(fs.existsSync(electronEntry), `Missing Electron executable: ${electronEntry}`)

  let preview = null
  let electron = null
  let childOutput = ''
  try {
    preview = spawn(process.execPath, [tsxEntry, previewScript], {
      cwd: root,
      env: { ...env, RVB_RED221_PREVIEW: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    preview.stdout?.on('data', chunk => { childOutput = (childOutput + String(chunk)).slice(-8000) })
    preview.stderr?.on('data', chunk => { childOutput = (childOutput + String(chunk)).slice(-8000) })
    await waitForHttp(`${baseUrl}/battle.html?mode=training`)

    const childEnv = { ...env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    electron = spawn(electronEntry, [scriptPath, '--electron-child'], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    electron.stdout?.on('data', chunk => { childOutput = (childOutput + String(chunk)).slice(-12000) })
    electron.stderr?.on('data', chunk => { childOutput = (childOutput + String(chunk)).slice(-12000) })
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron smoke timed out after 90 seconds')), 90000)
      electron.once('error', reject)
      electron.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve(code == null ? 1 : code)
        if (signal) childOutput += `\nElectron signal: ${signal}`
      })
    })
    if (exitCode !== 0) {
      throw new Error(`RED-221 Electron smoke failed with exit code ${exitCode}\n${childOutput}`)
    }
  } finally {
    stopProcessTree(electron?.pid)
    stopProcessTree(preview?.pid)
  }
}

const fixtureInstaller = `(() => {
  const clone = typeof GameEngine.safeCloneBattleState === 'function'
    ? GameEngine.safeCloneBattleState(window.__RED221_BASE_STATE__)
    : JSON.parse(JSON.stringify(window.__RED221_BASE_STATE__))
  const tileByKey = new Map((clone.map?.tiles || []).map(tile => [tile.x + ',' + tile.y, tile]))
  const blocked = new Set(['wall', 'hole', 'lava'])
  const passable = (x, y) => {
    const tile = tileByKey.get(x + ',' + y)
    const type = tile && ((tile.props && tile.props.type) || tile.type || 'floor')
    return !blocked.has(type)
  }
  const cells = []
  for (let y = 0; y < Number(clone.map?.height || 0); y += 1) {
    for (let x = 0; x < Number(clone.map?.width || 0); x += 1) {
      if (passable(x, y)) cells.push({ x, y })
    }
  }
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  const byTemplate = id => clone.pieces.find(piece => piece.templateId === id && piece.currentHp > 0)
  const caster = byTemplate('red-venom')
  const friendlyInvalid = byTemplate('arthas')
  const validEnemy = byTemplate('uther')
  const farEnemy = byTemplate('anduin')
  if (!caster || !friendlyInvalid || !validEnemy || !farEnemy) {
    throw new Error('Fixture roster is missing red-venom, arthas, uther, or anduin')
  }
  let selected = null
  for (const casterCell of cells) {
    if (selected) break
    for (const targetCell of cells) {
      if (distance(casterCell, targetCell) !== 1) continue
      caster.x = casterCell.x; caster.y = casterCell.y
      validEnemy.x = targetCell.x; validEnemy.y = targetCell.y
      const probe = BattleLegalActions.probeSkillTarget({
        snapshot: clone,
        playerId: 'training-red',
        pieceId: caster.instanceId,
        skillId: 'venom-claw-rend',
        skillsById,
        engine: GameEngine,
      })
      const candidate = probe && probe.preparation && probe.preparation.candidates || []
      if (!candidate.some(ref => ref && ref.type === 'piece' && ref.pieceId === validEnemy.instanceId)) continue
      const far = cells.find(cell => distance(casterCell, cell) >= 6 && distance(targetCell, cell) >= 3)
      const empty = cells.find(cell => distance(casterCell, cell) >= 4 && distance(targetCell, cell) >= 3 && distance(far || casterCell, cell) >= 2)
      if (!far || !empty) continue
      selected = { casterCell, targetCell, far, empty, probe }
      break
    }
  }
  if (!selected) throw new Error('Could not find a passable adjacent target fixture')
  caster.x = selected.casterCell.x; caster.y = selected.casterCell.y
  validEnemy.x = selected.targetCell.x; validEnemy.y = selected.targetCell.y
  friendlyInvalid.x = selected.far.x; friendlyInvalid.y = selected.far.y
  farEnemy.x = selected.empty.x; farEnemy.y = selected.empty.y
  clone.pieces = clone.pieces.map(piece => {
    if (piece.instanceId === caster.instanceId) {
      return Object.assign({}, piece, {
        x: selected.casterCell.x, y: selected.casterCell.y, currentHp: piece.maxHp || piece.currentHp,
        skills: (piece.skills || []).map(skill => skill.skillId === 'venom-claw-rend'
          ? Object.assign({}, skill, { currentCooldown: 0, usesRemaining: undefined }) : skill),
      })
    }
    if (piece.instanceId === validEnemy.instanceId) return Object.assign({}, piece, { x: selected.targetCell.x, y: selected.targetCell.y })
    if (piece.instanceId === friendlyInvalid.instanceId) return Object.assign({}, piece, { x: selected.far.x, y: selected.far.y })
    if (piece.instanceId === farEnemy.instanceId) return Object.assign({}, piece, { x: selected.empty.x, y: selected.empty.y })
    return piece
  })
  clone.players = (clone.players || []).map(player => Object.assign({}, player, player.playerId === 'training-red'
    ? { actionPoints: 10, maxActionPoints: 10, chargePoints: 10, maxChargePoints: 10 }
    : { actionPoints: 0, maxActionPoints: 10 }))
  clone.turn = Object.assign({}, clone.turn, { currentPlayerId: 'training-red', phase: 'action' })
  clone.pendingTargetSelection = undefined
  clone.pendingOptionSelection = undefined
  clone.presentationEvents = []
  G = clone
  myPlayerId = 'training-red'
  myFaction = getTrainingPlayerFaction(myPlayerId)
  selectedPieceId = null
  pendingMove = false
  pendingSkill = null
  pendingCardAction = null
  targetSubmissionPending = null
  pendingBoardTargetSelection = { selectionId: null, selectedPieceIds: [], selectedCells: [] }
  if (typeof clearPendingActionFeedback === 'function') clearPendingActionFeedback('red221-fixture')
  render()
  const preparation = selected.probe && selected.probe.preparation
  window.__RED221_FIXTURE__ = {
    casterId: caster.instanceId,
    invalidPieceId: friendlyInvalid.instanceId,
    validTargetId: validEnemy.instanceId,
    caster: selected.casterCell,
    invalidPiece: selected.far,
    validTarget: selected.targetCell,
    empty: selected.empty,
    preparation: preparation || null,
  }
  return window.__RED221_FIXTURE__
})()`

const readFlowExpression = `(() => ({
  selectedPieceId: selectedPieceId || null,
  tutorialMode: typeof TUTORIAL_MODE !== 'undefined' ? TUTORIAL_MODE : null,
  trainingMode: typeof TRAINING_MODE !== 'undefined' ? TRAINING_MODE : null,
  pendingSkill: pendingSkill ? {
    skillId: pendingSkill.skillId || null,
    selectionId: pendingSkill.preparation && pendingSkill.preparation.selectionId || null,
    stateRevision: pendingSkill.preparation && pendingSkill.preparation.stateRevision,
  } : null,
  pendingCardAction: pendingCardAction ? true : false,
  targetSubmissionPending: targetSubmissionPending ? {
    clientActionId: targetSubmissionPending.clientActionId || null,
    label: targetSubmissionPending.label || null,
  } : null,
  targetOverlay: !!document.getElementById('targetOverlay')?.classList.contains('show'),
  targetMode: document.body.classList.contains('target-mode-active'),
  status: document.getElementById('statusMsg')?.textContent || '',
  targetHp: (() => { const p = G?.pieces?.find(piece => piece.instanceId === window.__RED221_FIXTURE__?.validTargetId); return p ? p.currentHp : null })(),
  casterHp: (() => { const p = G?.pieces?.find(piece => piece.instanceId === window.__RED221_FIXTURE__?.casterId); return p ? p.currentHp : null })(),
  actionPoints: G?.players?.find(player => player.playerId === 'training-red')?.actionPoints ?? null,
  debugActionCount: G?.extensions?.debugBattle?.actionLog?.length ?? null,
  debugAppliedActionIds: G?.extensions?.debugBattle?.appliedActionIds?.length ?? null,
  lastDebugAction: G?.extensions?.debugBattle?.actionLog?.at(-1)?.action || null,
  presentationEventCount: G?.presentationEvents?.length ?? null,
  lastPresentationActionId: G?.presentationEvents?.at(-1)?.actionId || null,
  trainingPutCalls: window.__RED221_PUTS?.length || 0,
  engineApplyCalls: window.__RED221_ENGINE_APPLY?.length || 0,
  engineActionCalls: window.__RED221_ENGINE_ACTION_CALLS?.slice(-6) || [],
  engineApplyWrapped: !!(window.GameEngine && window.GameEngine.__RED221_APPLY_WRAPPED),
  engineApplyType: typeof window.GameEngine?.applyBattleAction,
  engineRecordType: typeof window.GameEngine?.recordBattlePresentation,
  engineRunType: typeof window.GameEngine?.runBattleAction,
  engineRecordWrapped: !!(window.GameEngine && window.GameEngine.__RED221_RECORD_WRAPPED),
  ensureWrapped: !!(window.RvBGameEngine && window.RvBGameEngine.__RED221_ENSURE_WRAPPED),
  lastPut: window.__RED221_PUTS?.at(-1) || null,
}))()`

const instrumentationScript = `(() => {
  window.__RED221_PUTS = []
  window.__RED221_ENGINE_APPLY = []
  window.__RED221_ENGINE_ACTION_CALLS = []
  window.__RED221_DELAY_NEXT_PUT_MS = 0
  if (!window.__RED221_TRAINING_API_ORIGINAL && typeof window.trainingApiFetch === 'function') {
    window.__RED221_TRAINING_API_ORIGINAL = window.trainingApiFetch
    window.trainingApiFetch = async function (method, body) {
      if (method === 'PUT') {
        window.__RED221_PUTS.push(JSON.parse(JSON.stringify(body && body.action || null)))
        const wait = Number(window.__RED221_DELAY_NEXT_PUT_MS || 0)
        window.__RED221_DELAY_NEXT_PUT_MS = 0
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      }
      return window.__RED221_TRAINING_API_ORIGINAL.apply(this, arguments)
    }
  }
  const wrapEngine = engine => {
    if (!engine || engine.__RED221_APPLY_WRAPPED || typeof engine.applyBattleAction !== 'function') return
    const originalApply = engine.applyBattleAction
    engine.applyBattleAction = function (state, action) {
      window.__RED221_ENGINE_APPLY.push(JSON.parse(JSON.stringify(action || null)))
      window.__RED221_ENGINE_ACTION_CALLS.push({ kind: 'applyBattleAction', action: JSON.parse(JSON.stringify(action || null)) })
      return originalApply.call(this, state, action)
    }
    engine.__RED221_APPLY_WRAPPED = true
    if (typeof engine.runBattleAction === 'function' && !engine.__RED221_RUN_WRAPPED) {
      const originalRun = engine.runBattleAction
      engine.runBattleAction = function (state, action) {
        window.__RED221_ENGINE_ACTION_CALLS.push({ kind: 'runBattleAction', action: JSON.parse(JSON.stringify(action || null)) })
        return originalRun.apply(this, arguments)
      }
      engine.__RED221_RUN_WRAPPED = true
    }
    if (typeof engine.recordBattlePresentation === 'function' && !engine.__RED221_RECORD_WRAPPED) {
      const originalRecord = engine.recordBattlePresentation
      engine.recordBattlePresentation = function (state, execute, ...rest) {
        window.__RED221_ENGINE_ACTION_CALLS.push({ kind: 'recordBattlePresentation' })
        return originalRecord.call(this, state, execute, ...rest)
      }
      engine.__RED221_RECORD_WRAPPED = true
    }
  }
  wrapEngine(window.GameEngine || (typeof GameEngine !== 'undefined' ? GameEngine : null))
  if (window.RvBGameEngine && typeof window.RvBGameEngine.ensure === 'function' && !window.RvBGameEngine.__RED221_ENSURE_WRAPPED) {
    const originalEnsure = window.RvBGameEngine.ensure
    window.RvBGameEngine.ensure = async function () {
      const engine = await originalEnsure.apply(this, arguments)
      wrapEngine(engine)
      return engine
    }
    window.RvBGameEngine.__RED221_ENSURE_WRAPPED = true
  }
  return { trainingApiFetch: typeof window.trainingApiFetch, engineApply: typeof GameEngine?.applyBattleAction }
})()`

async function runElectronSmoke() {
  const { app, BrowserWindow } = require('electron')
  // battle.html requires a real WebGL-backed BattleRenderer3D instance. On
  // CI/headless Windows hosts, ask Chromium for its bundled software GPU
  // path instead of disabling WebGL (which prevents page init entirely).
  app.commandLine.appendSwitch('use-gl', 'swiftshader')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  await app.whenReady()
  const logs = []
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  win.webContents.on('console-message', (_event, _level, message) => logs.push(String(message)))
  win.webContents.on('did-fail-load', (_event, code, description, url) => logs.push(`did-fail-load ${code} ${description} ${url}`))
  let debuggerAttached = false
  const evaluate = expression => win.webContents.executeJavaScript(expression, true)
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const result = await evaluate(expression)
        if (result) return result
      } catch (error) { lastError = error }
      await delay(100)
    }
    throw new Error(`${label} timed out: ${lastError || expression}`)
  }
  const pointFor = async (expression, selectorLabel) => {
    const point = await evaluate(expression)
    ensure(point && Number.isFinite(point.x) && Number.isFinite(point.y), `Could not locate ${selectorLabel}: ${JSON.stringify(point)}`)
    return { x: Math.round(point.x), y: Math.round(point.y) }
  }
  const selectorPoint = selector => pointFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height }
  })()`, selector)
  const boardPoint = cell => pointFor(`(() => {
    // Click the board tile center. A tall piece's top is visually above its
    // tile and can project over the preceding isometric row, while the
    // production handler resolves a click through screenToCell().
    const projected = battlePresentation && battlePresentation.projectCell(${cell.x}, ${cell.y})
    return projected && { x: projected.clientX, y: projected.clientY }
  })()`, `cell ${cell.x},${cell.y}`)
  const mouseAt = async point => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y, movementX: 0, movementY: 0 })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await delay(130)
  }
  const cdp = async (method, params) => {
    if (!debuggerAttached) {
      win.webContents.debugger.attach('1.3')
      debuggerAttached = true
    }
    return win.webContents.debugger.sendCommand(method, params)
  }
  const touchAt = async point => {
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }] })
    await delay(70)
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await delay(180)
  }
  const tap = async (point, mode) => mode === 'touch' ? touchAt(point) : mouseAt(point)
  const clickSelector = async (selector, mode) => tap(await selectorPoint(selector), mode)
  const closeTileStatusIfOpen = async mode => {
    const open = await evaluate(`(() => {
      const panel = document.getElementById('tileStatusPanel')
      if (!panel || panel.getAttribute('aria-hidden') === 'true') return false
      const close = panel.querySelector('.ts-close')
      const rect = close?.getBoundingClientRect()
      return !!(close && rect && rect.width > 0 && rect.height > 0)
    })()`)
    if (open) {
      await clickSelector('#tileStatusPanel .ts-close', mode)
      await delay(120)
    }
  }
  const snapshot = async label => ({ label, ...(await evaluate(readFlowExpression)) })
  const screenshot = async name => {
    fs.mkdirSync(evidenceRoot, { recursive: true })
    fs.writeFileSync(path.join(evidenceRoot, name), (await win.webContents.capturePage()).toPNG())
  }

  const evidence = {
    sourceRoot: root,
    baseUrl,
    inputModes: { desktop: 'Electron webContents.sendInputEvent mouse events', mobile: 'Chrome DevTools Input.dispatchTouchEvent via Electron debugger' },
    setupInjection: 'Training checkbox values and deterministic engine fixture are page-runtime injections; selection/action/cancel clicks are browser input events.',
    baselineExpected: 'The pre-RED-221 red220 source is expected to fail at illegal occupied target because onCellClick switches the caster.',
    desktop: {},
    mobile: {},
    rejection: {},
    screenshots: [],
  }

  try {
    await win.loadURL(`${baseUrl}/battle.html?mode=training&playerId=training-red`)
    await waitFor(`document.readyState === 'complete' && typeof PIECES_BY_ID === 'object' && Object.keys(PIECES_BY_ID).length > 0`, 30000, 'battle.html local data')
    await waitFor(`document.getElementById('trainingSetupOverlay')?.classList.contains('show') === true`, 30000, 'training setup')
    const setup = await evaluate(`(() => {
      refreshTrainingSetupPieces()
      const choose = (listId, values) => {
        const wanted = new Set(values)
        const inputs = Array.from(document.querySelectorAll('#' + listId + ' input[type=checkbox]'))
        inputs.forEach(input => { input.checked = wanted.has(input.value) })
        return { values, found: inputs.filter(input => wanted.has(input.value)).map(input => input.value) }
      }
      return {
        first: choose('trainingFirstPieces', ['red-venom', 'arthas']),
        second: choose('trainingSecondPieces', ['uther', 'anduin']),
        firstFaction: document.getElementById('trainingFirstFaction')?.value,
        secondFaction: document.getElementById('trainingSecondFaction')?.value,
      }
    })()`)
    ensure(setup.first.found.length === 2 && setup.second.found.length === 2, `Training fixture pieces missing: ${JSON.stringify(setup)}`)
    await clickSelector('#trainingSetupOverlay button[onclick="startTrainingFromSetup()"]', 'mouse')
    await waitFor(`G && G.turn && G.turn.phase === 'action' && G.pieces?.some(piece => piece.templateId === 'red-venom') && battlePresentation && _use3d === true`, 30000, 'training battle')
    await evaluate(`window.__RED221_BASE_STATE__ = GameEngine.safeCloneBattleState(G); true`)
    const fixture = await evaluate(fixtureInstaller)
    ensure(fixture && fixture.casterId && fixture.preparation?.candidates?.some(ref => ref.pieceId === fixture.validTargetId), `Invalid target fixture preparation: ${JSON.stringify(fixture)}`)
    await evaluate(instrumentationScript)
    await evaluate(`(() => {
      window.__RED221_INPUT_EVENTS = []
      const canvas = document.querySelector('#boardStage3d canvas')
      if (canvas) ['pointerdown', 'pointerup', 'click'].forEach(type => canvas.addEventListener(type, event => {
        window.__RED221_INPUT_EVENTS.push({ type, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY })
      }, true))
      return !!canvas
    })()`)

    // Desktop: select a caster and skill, then try two invalid targets. The
    // click path is the production renderer -> presentation -> battle.html path.
    const casterPoint = await boardPoint(fixture.caster)
    await tap(casterPoint, 'mouse')
    const selected = await snapshot('after-caster-click')
    if (selected.selectedPieceId !== fixture.casterId) {
      const inputDebug = await evaluate(`(() => ({
        point: ${JSON.stringify(casterPoint)},
        projectedCell: battlePresentation && battlePresentation.screenToCell(${casterPoint.x}, ${casterPoint.y}),
        canvas: (() => { const e = document.querySelector('#boardStage3d canvas'); const r = e && e.getBoundingClientRect(); return r && { left: r.left, top: r.top, width: r.width, height: r.height } })(),
        events: window.__RED221_INPUT_EVENTS,
        model: (() => { const m = battlePresentation && battlePresentation.getModel && battlePresentation.getModel(); return m && { selection: m.selection, interaction: m.interaction, pieces: (m.interactionPieces || m.pieces || []).map(p => ({ id: p.id, x: p.x, y: p.y, visible: p.visible })) } })(),
      }))()`)
      throw new Error(`Caster was not selected by real mouse input: ${JSON.stringify({ selected, inputDebug })}`)
    }
    // The normal board click also opens the real tile-status panel. Close it
    // through its visible button so it cannot cover the adjacent legal target.
    await closeTileStatusIfOpen('mouse')
    const skillSelector = '.character-cast[data-skill-id="venom-claw-rend"]'
    // First opening the real character sheet may show the one-time skill
    // description guide. Dismiss it with the same browser mouse path a user
    // would use; otherwise its modal backdrop legitimately intercepts casts.
    if (await evaluate('!!document.querySelector("dialog.skill-reading-guide[open]")')) {
      await clickSelector('dialog.skill-reading-guide button', 'mouse')
      await waitFor('!document.querySelector("dialog.skill-reading-guide[open]")', 5000, 'skill reading guide dismissal')
    }
    const skillButtonDebug = await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(skillSelector)}))
      const menu = document.getElementById('pieceContextMenu')
      const menuRect = menu?.getBoundingClientRect()
      const menuStyle = menu ? getComputedStyle(menu) : null
      return buttons.map(button => { const r = button.getBoundingClientRect(); return {
        disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled'),
        text: button.textContent, menuOpen: !!button.closest('#pieceContextMenu')?.classList.contains('is-open'),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        menuRect: menuRect && { left: menuRect.left, top: menuRect.top, width: menuRect.width, height: menuRect.height },
        menuStyle: menuStyle && { display: menuStyle.display, visibility: menuStyle.visibility, opacity: menuStyle.opacity, position: menuStyle.position, left: menuStyle.left, top: menuStyle.top, width: menuStyle.width, height: menuStyle.height },
        buttonOffset: { width: button.offsetWidth, height: button.offsetHeight },
      } })
    })()`)
    ensure(skillButtonDebug.length > 0, `No venom claw skill button after caster selection: ${JSON.stringify(skillButtonDebug)}`)
    // The real tabletop character dock is a scrollable left sheet. Bring its
    // cast control into the viewport before sending the physical mouse click,
    // matching the user-visible scroll needed on this 720px desktop frame.
    await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(skillSelector)})
      if (button) button.scrollIntoView({ block: 'center', inline: 'nearest' })
      return !!button
    })()`)
    await delay(180)
    const skillInputTarget = await evaluate(`(() => {
      window.__RED221_SKILL_CLICKS = []
      const button = document.querySelector(${JSON.stringify(skillSelector)})
      if (!button) return null
      button.addEventListener('click', event => window.__RED221_SKILL_CLICKS.push({ target: event.target?.className || event.target?.tagName, current: event.currentTarget?.className }), true)
      const r = button.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { point: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, hit: hit && { tag: hit.tagName, id: hit.id, className: hit.className } }
    })()`)
    const skillButtonAfterScroll = await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(skillSelector)})
      const r = button?.getBoundingClientRect()
      const sheet = button?.closest('.pi-sheet')
      return { rect: r && { left: r.left, top: r.top, width: r.width, height: r.height }, sheetScrollTop: sheet?.scrollTop || 0, bodyScrollTop: document.scrollingElement?.scrollTop || 0 }
    })()`)
    await clickSelector(skillSelector, 'mouse')
    const armed = await snapshot('after-skill-click')
    const skillClickDebug = await evaluate('({ events: window.__RED221_SKILL_CLICKS, status: document.getElementById("statusMsg")?.textContent || "" })')
    ensure(armed.selectedPieceId === fixture.casterId && armed.pendingSkill?.skillId === 'venom-claw-rend', `Skill target mode did not arm: ${JSON.stringify({ armed, skillButtonDebug, skillButtonAfterScroll, skillInputTarget, skillClickDebug })}`)
    evidence.desktop = { setup, fixture, selected, armed }
    await tap(await boardPoint(fixture.invalidPiece), 'mouse')
    const occupiedRejected = await snapshot('after-invalid-occupied-mouse')
    evidence.desktop.occupiedRejected = occupiedRejected
    await screenshot('desktop-1280x720-after-invalid-occupied.png')
    evidence.screenshots.push('desktop-1280x720-after-invalid-occupied.png')
    ensure(occupiedRejected.selectedPieceId === fixture.casterId && occupiedRejected.pendingSkill?.skillId === 'venom-claw-rend', `Illegal occupied target changed the draft: ${JSON.stringify(occupiedRejected)}`)
    ensure(/目标|技能|合法/.test(occupiedRejected.status), `Illegal occupied target had no clear status feedback: ${JSON.stringify(occupiedRejected)}`)
    await tap(await boardPoint(fixture.empty), 'mouse')
    const emptyRejected = await snapshot('after-invalid-empty-mouse')
    ensure(emptyRejected.selectedPieceId === fixture.casterId && emptyRejected.pendingSkill?.skillId === 'venom-claw-rend', `Illegal empty target changed the draft: ${JSON.stringify(emptyRejected)}`)
    ensure(emptyRejected.targetOverlay && emptyRejected.targetMode, `Illegal empty target exited target mode: ${JSON.stringify(emptyRejected)}`)
    await screenshot('desktop-1280x720-target-retry.png')
    evidence.screenshots.push('desktop-1280x720-target-retry.png')

    const beforeLegal = await snapshot('before-legal-retry')
    await closeTileStatusIfOpen('mouse')
    await evaluate('window.__RED221_DELAY_NEXT_PUT_MS = 550; true')
    const validTargetPoint = await boardPoint(fixture.validTarget)
    const validTargetInputDebug = await evaluate(`(() => ({
      point: ${JSON.stringify(validTargetPoint)},
      screenToCell: battlePresentation && battlePresentation.screenToCell(${validTargetPoint.x}, ${validTargetPoint.y}),
      hit: (() => { const e = document.elementFromPoint(${validTargetPoint.x}, ${validTargetPoint.y}); return e && { tag: e.tagName, id: e.id, className: e.className } })(),
      target: window.__RED221_FIXTURE__?.validTarget,
      pendingValidTargets: pendingSkill && pendingSkill.validTargets && Array.from(pendingSkill.validTargets),
      pendingPreparation: pendingSkill && pendingSkill.preparation,
      inputEvents: window.__RED221_INPUT_EVENTS?.slice(-8),
      camera: battlePresentation && battlePresentation.getModel && (() => { const m = battlePresentation.getModel(); return m && { selection: m.selection, legal: m.legal } })(),
    }))()`)
    await tap(validTargetPoint, 'mouse')
    const waiting = await snapshot('waiting-after-legal-mouse')
    ensure(waiting.targetSubmissionPending, `Legal retry did not enter authoritative waiting state: ${JSON.stringify({ waiting, validTargetInputDebug })}`)
    ensure(waiting.trainingPutCalls === 1, `Legal retry submitted more than once before confirmation: ${JSON.stringify(waiting)}`)
    // A second real click while the first target is waiting must be ignored.
    await tap(await boardPoint(fixture.validTarget), 'mouse')
    const duplicateAttempt = await snapshot('after-duplicate-legal-mouse')
    ensure(duplicateAttempt.trainingPutCalls === 1, `Waiting target accepted a duplicate click: ${JSON.stringify(duplicateAttempt)}`)
    await delay(900)
    const accepted = await snapshot('after-legal-retry')
    ensure(accepted.trainingPutCalls === 1, `Legal retry did not execute exactly one transport action: ${JSON.stringify(accepted)}`)
    // The production training adapter closes over its bundled engine method,
    // so an injected wrapper cannot observe that private call. The real page
    // still proves one authoritative transition through one PUT, one damage
    // result, and one AP charge; retain the wrapper count as diagnostic data.
    ensure(accepted.targetHp != null && accepted.targetHp < beforeLegal.targetHp, `Legal retry did not damage the valid target: ${JSON.stringify({ before: beforeLegal, accepted })}`)
    ensure(accepted.actionPoints === beforeLegal.actionPoints - 1, `Legal retry charged an unexpected number of action points: ${JSON.stringify({ before: beforeLegal, accepted })}`)
    ensure(!accepted.pendingSkill && !accepted.targetSubmissionPending && !accepted.targetMode, `Accepted action left target mode active: ${JSON.stringify(accepted)}`)
    evidence.desktop = { ...evidence.desktop, occupiedRejected, emptyRejected, waiting, duplicateAttempt, accepted }

    if (process.env.RVB_FEEDBACK_DURATION === '1') {
      await evaluate(`showTurnAnnounce('回合提示验收', '#ecd4a6'); spawnFloater(${fixture.caster.x}, ${fixture.caster.y}, '验收 −4', '#fff', false); true`)
      // Hidden Electron windows need an initial paint before CSS animation
      // timelines start; this captures the first frame without showing a window.
      await win.webContents.capturePage()
      await delay(1100)
      const readable = await evaluate(`({
        turnOpacity: Number(getComputedStyle(document.getElementById('turnAnnounce')).opacity),
        floaterVisible: Array.from(document.querySelectorAll('.dmg-float')).some(el => el.textContent === '验收 −4' && Number(getComputedStyle(el).opacity) > 0.8),
      })`)
      ensure(readable.turnOpacity > 0.8 && readable.floaterVisible, `Feedback disappeared before reading: ${JSON.stringify(readable)}`)
      await screenshot('desktop-feedback-after-1100ms.png')
      evidence.screenshots.push('desktop-feedback-after-1100ms.png')
      await delay(2100)
      const cleaned = await evaluate(`({
        turnHidden: !document.getElementById('turnAnnounce').classList.contains('show'),
        floaterRemoved: !Array.from(document.querySelectorAll('.dmg-float')).some(el => el.textContent === '验收 −4'),
      })`)
      ensure(cleaned.turnHidden && cleaned.floaterRemoved, `Feedback did not expire: ${JSON.stringify(cleaned)}`)
      evidence.feedbackTiming = { readableAt1100ms: readable, cleanedAt3200ms: cleaned }
    }

    // Explicit cancel uses a fresh fixture so the skill cooldown from the
    // accepted action cannot hide the cancel path.
    await evaluate(fixtureInstaller)
    await tap(await boardPoint(fixture.caster), 'mouse')
    await closeTileStatusIfOpen('mouse')
    await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(skillSelector)})
      if (button) button.scrollIntoView({ block: 'center', inline: 'nearest' })
      return !!button
    })()`)
    await delay(120)
    await clickSelector(skillSelector, 'mouse')
    const beforeCancel = await snapshot('before-explicit-cancel')
    await clickSelector('#targetCancelButton', 'mouse')
    const cancelled = await snapshot('after-explicit-cancel')
    ensure(beforeCancel.pendingSkill?.skillId === 'venom-claw-rend', `Cancel fixture did not enter target mode: ${JSON.stringify(beforeCancel)}`)
    ensure(cancelled.selectedPieceId === fixture.casterId && !cancelled.pendingSkill && !cancelled.targetOverlay && !cancelled.targetMode, `Explicit cancel did not exit target mode: ${JSON.stringify(cancelled)}`)
    evidence.desktop.cancel = { beforeCancel, cancelled }

    // Inject a real authoritative pending session with the existing engine
    // protocol, then send a malformed pendingTargetSelect through the actual
    // page handler. This is the only JS-injected command: a malformed target
    // cannot be generated by a legal pointer path.
    await evaluate(fixtureInstaller)
    const rejectionSetup = await evaluate(`(() => {
      const f = window.__RED221_FIXTURE__
      const prep = f.preparation
      selectedPieceId = f.casterId
      G.pendingTargetSelection = {
        playerId: 'training-red', ownerPlayerId: 'training-red', source: { type: 'skill', id: 'venom-claw-rend', pieceId: f.casterId },
        targetType: 'piece', range: 1, filter: 'enemy', min: 1, max: 1, step: 0, selectedTargets: [],
        selectionId: prep.selectionId, stateRevision: prep.stateRevision, candidates: prep.candidates, canCancel: true,
      }
      enterActionTargetMode({ type: 'useBasicSkill', playerId: 'training-red', pieceId: f.casterId, skillId: 'venom-claw-rend' }, prep)
      pendingSkill.turnTargetActionType = 'pendingTargetSelect'
      pendingSkill.turnTargetPlayerId = 'training-red'
      render()
      return { pending: G.pendingTargetSelection, flow: ${readFlowExpression} }
    })()`)
    ensure(rejectionSetup.flow.pendingSkill?.skillId === 'venom-claw-rend', `Rejection fixture did not retain the draft before submit: ${JSON.stringify(rejectionSetup)}`)
    const invalidSubmission = await evaluate(`(() => submitTargetAction({
      type: 'pendingTargetSelect', playerId: 'training-red', targetPieceId: window.__RED221_FIXTURE__.invalidPieceId,
      selectionId: window.__RED221_FIXTURE__.preparation.selectionId, stateRevision: window.__RED221_FIXTURE__.preparation.stateRevision,
    }, currentTargetSourceName()))()`)
    ensure(invalidSubmission === true, `Malformed pending target was not submitted through page handler: ${invalidSubmission}`)
    await delay(700)
    const rejected = await snapshot('after-authority-rejection')
    ensure(!rejected.targetSubmissionPending, `Rejected pending target kept the in-flight lock: ${JSON.stringify(rejected)}`)
    ensure(rejected.pendingSkill?.skillId === 'venom-claw-rend', `Rejected pending target discarded the retry draft: ${JSON.stringify(rejected)}`)
    const pendingAfterRejection = await evaluate('G.pendingTargetSelection !== undefined')
    ensure(pendingAfterRejection, 'Rejected pending target unexpectedly mutated the authoritative session')
    ensure(/拒绝|重新选择|目标/.test(rejected.status), `Rejected pending target had no actionable status feedback: ${JSON.stringify(rejected)}`)
    evidence.rejection = { rejectionSetup, invalidSubmission, rejected }

    // Mobile landscape: repeat the invalid occupied/empty target checks with
    // actual touch events, capture the requested 844x390 frame, then cancel.
    win.setContentSize(844, 390)
    await delay(350)
    await evaluate(fixtureInstaller)
    await tap(await boardPoint(fixture.caster), 'touch')
    await closeTileStatusIfOpen('touch')
    await clickSelector('#mobileSkillsToggle', 'touch')
    await waitFor('document.getElementById("pieceContextMenu")?.classList.contains("is-open") === true', 5000, 'mobile skill dock')
    await clickSelector('.piece-context-skill[data-skill-id="venom-claw-rend"]', 'touch')
    const mobileArmed = await snapshot('mobile-after-skill-touch')
    await tap(await boardPoint(fixture.invalidPiece), 'touch')
    const mobileOccupiedRejected = await snapshot('mobile-after-invalid-occupied-touch')
    await tap(await boardPoint(fixture.empty), 'touch')
    const mobileEmptyRejected = await snapshot('mobile-after-invalid-empty-touch')
    ensure(mobileArmed.pendingSkill?.skillId === 'venom-claw-rend', `Mobile touch did not arm the skill: ${JSON.stringify(mobileArmed)}`)
    ensure(mobileOccupiedRejected.selectedPieceId === fixture.casterId && mobileOccupiedRejected.pendingSkill?.skillId === 'venom-claw-rend', `Mobile occupied target changed the draft: ${JSON.stringify(mobileOccupiedRejected)}`)
    ensure(mobileEmptyRejected.selectedPieceId === fixture.casterId && mobileEmptyRejected.pendingSkill?.skillId === 'venom-claw-rend', `Mobile empty target changed the draft: ${JSON.stringify(mobileEmptyRejected)}`)
    await screenshot('mobile-844x390-target-retry.png')
    evidence.screenshots.push('mobile-844x390-target-retry.png')
    await clickSelector('#targetCancelButton', 'touch')
    const mobileCancelled = await snapshot('mobile-after-explicit-cancel-touch')
    ensure(mobileCancelled.selectedPieceId === fixture.casterId && !mobileCancelled.pendingSkill && !mobileCancelled.targetOverlay && !mobileCancelled.targetMode, `Mobile touch cancel did not exit target mode: ${JSON.stringify(mobileCancelled)}`)
    evidence.mobile = { mobileArmed, mobileOccupiedRejected, mobileEmptyRejected, mobileCancelled }

    evidence.ok = true
    evidence.viewport = { desktop: [1280, 720], mobile: [844, 390] }
    fs.mkdirSync(evidenceRoot, { recursive: true })
    fs.writeFileSync(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, evidence: path.join(evidenceRoot, 'results.json'), desktop: evidence.desktop.accepted, mobile: evidence.mobile.mobileCancelled }))
  } catch (error) {
    evidence.ok = false
    evidence.error = String(error && error.stack || error)
    evidence.console = logs.slice(-100)
    try { fs.mkdirSync(evidenceRoot, { recursive: true }); fs.writeFileSync(path.join(evidenceRoot, 'results.json'), JSON.stringify(evidence, null, 2) + '\n') } catch {}
    throw error
  } finally {
    try { if (debuggerAttached) win.webContents.debugger.detach() } catch {}
    if (!win.isDestroyed()) win.destroy()
    app.quit()
  }
}

if (isElectronChild) {
  runElectronSmoke().then(() => process.exit(0)).catch(error => {
    console.error(error && error.stack || error)
    process.exit(1)
  })
} else {
  runNodeHarness().catch(error => {
    console.error(error && error.stack || error)
    process.exitCode = 1
  })
}
