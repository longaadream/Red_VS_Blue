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
  const friendlyInvalid = byTemplate('dark-muzan')
  const validEnemy = byTemplate('uther')
  const farEnemy = byTemplate('anduin')
  if (!caster || !friendlyInvalid || !validEnemy || !farEnemy) {
    throw new Error('Fixture roster is missing red-venom, dark-muzan, uther, or anduin')
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      offscreen: process.env.RVB_FLOATER_STACKING === '1' || process.env.RVB_SKILL_PREVIEW === '1' },
  })
  if (process.env.RVB_FLOATER_STACKING === '1' || process.env.RVB_SKILL_PREVIEW === '1') win.webContents.setFrameRate(60)
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
  const touchSwipe = async (start, end) => {
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: start.x, y: start.y, radiusX: 1, radiusY: 1, force: 1 }] })
    const steps = 6
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: Math.round(start.x + (end.x - start.x) * progress), y: Math.round(start.y + (end.y - start.y) * progress), radiusX: 1, radiusY: 1, force: 1 }] })
      await delay(25)
    }
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await delay(220)
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

  // RED-225 layout checks intentionally run only when requested.  They use
  // the same real Electron input helpers as the selection regression above;
  // the page-runtime fixture remains setup-only and never replaces the
  // pointer/touch path under test.
  const inspectSkillLayout = async label => evaluate(`(() => {
    const modal = document.getElementById('pieceInfoModal')
    const sheet = modal?.querySelector('.pi-sheet')
    const rows = Array.from(document.querySelectorAll('#pieceInfoContent .pi-skill'))
    const visible = element => {
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const piece = G?.pieces?.find(candidate => candidate.instanceId === currentPieceInfoId)
    const displaySkills = piece && typeof pieceInfoDisplaySkills === 'function' ? pieceInfoDisplaySkills(piece) : []
    return {
      label: ${JSON.stringify(label)},
      modal: {
        visible: visible(modal),
        dock: !!modal?.classList.contains('character-dock'),
        ariaModal: modal?.getAttribute('aria-modal') || null,
      },
      currentPieceInfoId: typeof currentPieceInfoId !== 'undefined' ? currentPieceInfoId || null : null,
      pieceId: currentPieceInfoId || null,
      displaySkillCount: displaySkills.length,
      rows: rows.map((row, index) => {
        const header = row.querySelector('.pi-skill-header')
        const description = row.querySelector('.pi-skill-desc')
        const cast = row.querySelector('.character-cast')
        const headerRect = header?.getBoundingClientRect()
        const castRect = cast?.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const castStyle = cast ? getComputedStyle(cast) : null
        return {
          index,
          text: description?.textContent?.trim() || '',
          descriptionVisible: visible(description),
          row: { left: rowRect.left, top: rowRect.top, width: rowRect.width, height: rowRect.height },
          header: headerRect && { left: headerRect.left, top: headerRect.top, width: headerRect.width, height: headerRect.height },
          cast: castRect && { left: castRect.left, top: castRect.top, width: castRect.width, height: castRect.height, disabled: cast.disabled, position: castStyle.position, topStyle: castStyle.top, bottomStyle: castStyle.bottom, ariaLabel: cast.getAttribute('aria-label') || '' },
          ariaCurrent: row.getAttribute('aria-current') || null,
          passive: !cast,
          rowVisible: visible(row),
        }
      }),
      sheet: sheet && {
        clientHeight: sheet.clientHeight,
        scrollHeight: sheet.scrollHeight,
        scrollTop: sheet.scrollTop,
        overflowY: getComputedStyle(sheet).overflowY,
      },
      target: {
        pendingSkill: pendingSkill?.skillId || null,
        targetOverlay: !!document.getElementById('targetOverlay')?.classList.contains('show'),
      },
    }
  })()`)

  const verifySkillLayout = async fixture => {
    const before = await inspectSkillLayout('desktop-before-layout-read')
    ensure(before.modal.visible && before.modal.dock, `RED-225: selected piece sheet is not a persistent character dock: ${JSON.stringify(before)}`)
    ensure(before.rows.length === before.displaySkillCount && before.rows.length >= 3, `RED-225: skill descriptions are not all in one list: ${JSON.stringify(before)}`)
    ensure(before.rows.every(row => row.text && row.descriptionVisible), `RED-225: a skill description is missing or hidden: ${JSON.stringify(before)}`)
    const activeRows = before.rows.filter(row => row.cast)
    ensure(activeRows.length >= 1, `RED-225: no active skill title action was exposed: ${JSON.stringify(before)}`)
    ensure(activeRows.every(row => row.cast.width >= row.header.width * 0.9 && row.cast.height >= 40 && row.cast.ariaLabel && row.cast.top <= row.header.top + row.header.height + 4), `RED-225: active action is not a large title-row target: ${JSON.stringify(before)}`)
    const activeDomCheck = await evaluate(`(() => Array.from(document.querySelectorAll('#pieceInfoContent .pi-skill')).filter(row => row.querySelector('.character-cast')).every(row => row.querySelector('.character-cast')?.contains(row.querySelector('.pi-skill-header'))))()`)
    ensure(activeDomCheck, `RED-225: skill action is separate from its title row, so the title cannot be the single reading/release affordance: ${JSON.stringify(before)}`)

    const visibleDescriptionPoint = await pointFor(`(() => {
      const description = Array.from(document.querySelectorAll('#pieceInfoContent .pi-skill-desc')).find(element => {
        const r = element.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
      })
      if (!description) return null
      const r = description.getBoundingClientRect()
      return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }
    })()`, 'visible skill description')
    const beforeRead = await snapshot('red225-before-description-read')
    await mouseAt(visibleDescriptionPoint)
    const afterDescriptionRead = await snapshot('red225-after-description-read')
    ensure(afterDescriptionRead.pendingSkill === beforeRead.pendingSkill && afterDescriptionRead.trainingPutCalls === beforeRead.trainingPutCalls, `RED-225: reading a description changed skill selection or submitted an action: ${JSON.stringify({ beforeRead, afterDescriptionRead })}`)

    const sheetPoint = await pointFor(`(() => {
      const element = document.querySelector('#pieceInfoModal .pi-sheet')
      if (!element) return null
      const r = element.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + Math.min(160, r.height / 2) }
    })()`, 'skill description scroll area')
    const scrollBefore = await inspectSkillLayout('desktop-before-description-scroll')
    if (scrollBefore.sheet && scrollBefore.sheet.scrollHeight > scrollBefore.sheet.clientHeight + 2) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: sheetPoint.x, y: sheetPoint.y, deltaX: 0, deltaY: 360 })
      await delay(180)
      const scrollAfter = await inspectSkillLayout('desktop-after-description-scroll')
      ensure(scrollAfter.sheet.scrollTop > scrollBefore.sheet.scrollTop, `RED-225: skill list did not scroll internally: ${JSON.stringify({ scrollBefore, scrollAfter })}`)
      const afterScrollRead = await snapshot('red225-after-description-scroll')
      ensure(!afterScrollRead.pendingSkill && afterScrollRead.trainingPutCalls === beforeRead.trainingPutCalls, `RED-225: scrolling the description list changed skill selection or submitted an action: ${JSON.stringify(afterScrollRead)}`)
      before.scrollAfter = scrollAfter
    } else {
      before.scrollGap = 'List fits viewport for this 3-skill fixture; long-list scroll is covered by the UI suite.'
    }

    // Use the allied Muzan fixture only to exercise the keyword and
    // passive-row reading surface. No action is sent and no role data is
    // changed. Return to the real Venom board selection before casting.
    const alternate = await evaluate(`(() => {
      const piece = G?.pieces?.find(candidate => candidate.templateId === 'dark-muzan')
      if (!piece || typeof showPieceInfo !== 'function') return null
      showPieceInfo(piece.instanceId, false)
      return { instanceId: piece.instanceId }
    })()`)
    let alternateLayout = null
    let keywordRead = { attempted: false }
    if (alternate) {
      await delay(180)
      alternateLayout = await inspectSkillLayout('desktop-muzan-four-skill-read')
      ensure(alternateLayout.rows.length >= 4 && alternateLayout.rows.some(row => row.passive), `RED-225: four-skill/passive reading fixture was not rendered as one list: ${JSON.stringify(alternateLayout)}`)
      const keywordPoint = await evaluate(`(() => {
        const badge = Array.from(document.querySelectorAll('#pieceInfoContent .keyword-badge')).find(element => {
          const r = element.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight
        })
        if (!badge) return null
        const r = badge.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`)
      if (keywordPoint) {
        keywordRead.attempted = true
        const beforeKeyword = await snapshot('red225-before-keyword-read')
        await mouseAt(keywordPoint)
        const afterKeyword = await snapshot('red225-after-keyword-read')
        ensure(!afterKeyword.pendingSkill && afterKeyword.trainingPutCalls === beforeKeyword.trainingPutCalls, `RED-225: reading a keyword changed skill selection or submitted an action: ${JSON.stringify({ beforeKeyword, afterKeyword })}`)
        keywordRead.result = await evaluate(`(() => ({ open: !!document.querySelector('#pieceKeywordPanel.is-keyword-open'), text: document.getElementById('pieceKeywordPanel')?.textContent || '' }))()`)
        ensure(keywordRead.result.open, `RED-225: keyword read did not open its existing explanation panel: ${JSON.stringify(keywordRead)}`)
      }
    }
    await evaluate(`(() => { if (typeof showPieceInfo === 'function') showPieceInfo(${JSON.stringify(fixture.casterId)}, false); return true })()`)
    await delay(160)
    const restored = await inspectSkillLayout('desktop-caster-restored')
    ensure(restored.pieceId === fixture.casterId && restored.modal.visible, `RED-225: returning from cross-skill reading did not restore the caster sheet: ${JSON.stringify(restored)}`)
    return { before, afterDescriptionRead, alternate: alternateLayout, keywordRead, restored }
  }

  // RED-225 target feedback is intentionally split from the reading surface:
  // #targetOverlay is the short, top-of-screen status line and
  // #targetSelectionControls owns cancel/confirm inside the character sheet.
  // Keep this helper independent from the old target-mode-card layout;
  // a visible card under #targetOverlay is a regression for the new contract.
  const inspectTargetControls = async label => evaluate(`(() => {
    const visible = element => {
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const rect = element => {
      const value = element?.getBoundingClientRect()
      return value && { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }
    }
    const overlay = document.getElementById('targetOverlay')
    const prompt = document.getElementById('targetPromptText')
    const controls = document.getElementById('targetSelectionControls')
    const cancel = document.getElementById('targetCancelButton')
    const confirm = document.getElementById('targetConfirmButton')
    const promptStyle = prompt ? getComputedStyle(prompt) : null
    const targetSkill = controls?.closest('#pieceInfoContent .pi-skill.is-targeting-skill')
    const targetDescription = targetSkill?.querySelector('.pi-skill-desc')
    const targetSkillRect = targetSkill?.getBoundingClientRect()
    const targetDescriptionRect = targetDescription?.getBoundingClientRect()
    const parseRgb = value => {
      const match = String(value || '').match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i)
      return match ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) } : null
    }
    const promptRgb = parseRgb(promptStyle?.color)
    const independentCard = Array.from(document.querySelectorAll('#targetOverlay .target-mode-card')).find(visible)
    return {
      label: ${JSON.stringify(label)},
      overlay: { visible: visible(overlay), rect: rect(overlay), position: overlay ? getComputedStyle(overlay).position : null, childCount: overlay?.children.length || 0 },
      prompt: {
        text: prompt?.textContent?.trim() || '',
        visible: visible(prompt),
        rect: rect(prompt),
        whiteSpace: promptStyle?.whiteSpace || null,
        lineHeight: promptStyle?.lineHeight || null,
        color: promptStyle?.color || null,
        colorRgb: promptRgb,
        fontWeight: promptStyle?.fontWeight || null,
        textShadow: promptStyle?.textShadow || null,
        webkitTextStroke: promptStyle?.webkitTextStroke || null,
        backgroundColor: promptStyle?.backgroundColor || null,
        borderStyle: promptStyle?.borderStyle || null,
        borderWidth: promptStyle?.borderWidth || null,
      },
      controls: {
        visible: visible(controls),
        rect: rect(controls),
        insideDock: !!controls?.closest('#pieceInfoModal.character-dock'),
        insideOverlay: !!controls?.closest('#targetOverlay'),
        insideTargetingSkill: !!targetSkill,
        targetSkillClass: targetSkill?.className || null,
        targetSkillRect: rect(targetSkill),
        beforeDescription: !!(controls && targetDescription && controls.getBoundingClientRect().bottom <= targetDescription.getBoundingClientRect().top + 4),
        descriptionRect: rect(targetDescription),
        controlsParent: controls?.parentElement ? { tag: controls.parentElement.tagName, id: controls.parentElement.id || '', className: String(controls.parentElement.className || '') } : null,
      },
      cancel: { exists: !!cancel, visible: visible(cancel), hidden: !!cancel?.hidden, disabled: !!cancel?.disabled, rect: rect(cancel) },
      confirm: { exists: !!confirm, visible: visible(confirm), hidden: !!confirm?.hidden, disabled: !!confirm?.disabled, rect: rect(confirm) },
      independentCard: independentCard ? { visible: true, rect: rect(independentCard) } : null,
      viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    }
  })()`)

  const assertTargetPresentation = (snapshot, label) => {
    const prompt = snapshot.prompt || {}
    const controls = snapshot.controls || {}
    const rgb = prompt.colorRgb
    const luminance = rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : 0
    const weight = Number.parseInt(prompt.fontWeight, 10)
    const background = String(prompt.backgroundColor || '').toLowerCase()
    const borderWidth = Number.parseFloat(prompt.borderWidth)
    const hasOutline = (prompt.textShadow && prompt.textShadow !== 'none') || (prompt.webkitTextStroke && prompt.webkitTextStroke !== 'none' && !/^0(?:px)?\s/.test(prompt.webkitTextStroke))
    ensure(rgb && luminance >= 150, `${label}: target prompt is not a bright readable line: ${JSON.stringify(prompt)}`)
    ensure(Number.isFinite(weight) ? weight >= 700 : String(prompt.fontWeight).toLowerCase() === 'bold', `${label}: target prompt is not bold: ${JSON.stringify(prompt)}`)
    ensure(hasOutline, `${label}: target prompt has no dark text outline: ${JSON.stringify(prompt)}`)
    ensure(background === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/.test(background), `${label}: target prompt has an unexpected background: ${JSON.stringify(prompt)}`)
    ensure(!Number.isFinite(borderWidth) || borderWidth === 0, `${label}: target prompt has an unexpected border: ${JSON.stringify(prompt)}`)
    ensure(controls.insideTargetingSkill && controls.beforeDescription && !controls.insideOverlay, `${label}: cancel/confirm controls are not in the active skill title area before its description: ${JSON.stringify(controls)}`)
  }

  const verifyAkazaMultiStep = async fixture => {
    const setup = await evaluate(`(() => {
      const akaza = G?.pieces?.find(piece => piece.templateId === 'dark-akaza')
      const enemy = G?.pieces?.find(piece => piece.templateId === 'uther' && piece.currentHp > 0)
      const venom = G?.pieces?.find(piece => piece.templateId === 'red-venom')
      if (!akaza || !enemy || !venom) return null
      const blocked = new Set(['wall', 'hole', 'lava'])
      const cells = (G.map?.tiles || []).filter(tile => {
        const type = tile?.props?.type || tile?.type || 'floor'
        return !blocked.has(type) && tile?.props?.walkable !== false
      }).map(tile => ({ x: tile.x, y: tile.y }))
      const tileAt = (x, y) => cells.find(cell => cell.x === x && cell.y === y)
      const livingAt = (x, y, exceptId) => G.pieces.some(piece => piece.currentHp > 0 && piece.instanceId !== exceptId && piece.x === x && piece.y === y)
      const reserved = new Set([${JSON.stringify(fixture.caster)}, ${JSON.stringify(fixture.invalidPiece)}, ${JSON.stringify(fixture.empty)}].map(cell => cell.x + ',' + cell.y))
      akaza.x = ${JSON.stringify(fixture.caster.x)}; akaza.y = ${JSON.stringify(fixture.caster.y)}
      const cardinal = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      const openAdjacent = cell => cardinal.map(([dx, dy]) => ({ x: cell.x + dx, y: cell.y + dy }))
        .filter(candidate => tileAt(candidate.x, candidate.y) && !livingAt(candidate.x, candidate.y, enemy.instanceId) && !(candidate.x === akaza.x && candidate.y === akaza.y))
      const targetCandidates = cells
        .filter(cell => Math.max(Math.abs(cell.x - akaza.x), Math.abs(cell.y - akaza.y)) <= 3)
        .filter(cell => !(cell.x === akaza.x && cell.y === akaza.y))
        .filter(cell => !reserved.has(cell.x + ',' + cell.y) && !livingAt(cell.x, cell.y, enemy.instanceId))
        .map(cell => ({ cell, adjacent: openAdjacent(cell) }))
        .filter(entry => entry.adjacent.length >= 2)
      const preferred = targetCandidates.find(entry => entry.cell.x === ${JSON.stringify(fixture.validTarget.x)} && entry.cell.y === ${JSON.stringify(fixture.validTarget.y)})
      const targetEntry = preferred || targetCandidates[0]
      if (!targetEntry) return null
      const target = targetEntry.cell
      const relocation = targetEntry.adjacent[0]
      const legalLanding = targetEntry.adjacent[1]
      enemy.x = target.x; enemy.y = target.y
      venom.x = relocation.x; venom.y = relocation.y
      akaza.currentHp = akaza.maxHp || akaza.currentHp
      akaza.skills = (akaza.skills || []).map(skill => skill.skillId === 'akaza-flash-step'
        ? Object.assign({}, skill, { currentCooldown: 0, usesRemaining: undefined }) : skill)
      enemy.statusTags = (enemy.statusTags || []).filter(tag => tag?.type !== 'akaza-damaged')
      enemy.statusTags.push({ id: 'akaza-damaged-by:' + akaza.instanceId, type: 'akaza-damaged', sourceId: akaza.instanceId, lastDamageTurn: G.turn.turnNumber, visible: false, currentDuration: -1, remainingDuration: -1 })
      G.players = (G.players || []).map(player => player.playerId === 'training-red'
        ? Object.assign({}, player, { actionPoints: 10, maxActionPoints: 10, chargePoints: 10, maxChargePoints: 10 })
        : Object.assign({}, player, { actionPoints: 0, maxActionPoints: 10 }))
      G.turn = Object.assign({}, G.turn, { currentPlayerId: 'training-red', phase: 'action' })
      G.pendingTargetSelection = undefined
      G.pendingOptionSelection = undefined
      G.presentationEvents = []
      selectedPieceId = null
      pendingMove = false
      pendingSkill = null
      pendingCardAction = null
      targetSubmissionPending = null
      pendingBoardTargetSelection = { selectionId: null, selectedPieceIds: [], selectedCells: [] }
      render()
      return { akazaId: akaza.instanceId, enemyId: enemy.instanceId, relocation, legalLanding, attack: akaza.attack, target: { x: enemy.x, y: enemy.y } }
    })()`)
    if (!setup) return { skipped: 'Training profile does not expose dark-akaza, uther, and red-venom together.' }
    const multiFlow = label => evaluate(`(() => {
      const pending = pendingSkill
      const preparation = pending?.preparation
      const target = G?.pendingTargetSelection || (preparation ? {
        step: preparation.step ?? pending.pendingTargetIndex ?? 0,
        selectionMode: preparation.selectionMode || null,
        canCancel: preparation.canCancel !== false,
        selectedTargets: pending.selectedTargets || [],
        candidates: preparation.candidates || [],
      } : null)
      const akaza = G?.pieces?.find(piece => piece.instanceId === ${JSON.stringify(setup.akazaId)})
      return {
        label: ${JSON.stringify(label)},
        selectedPieceId: selectedPieceId || null,
        pendingSkill: pending && { skillId: pending.skillId || null, pendingTargetIndex: pending.pendingTargetIndex ?? null, selectionId: pending.preparation?.selectionId || null },
        target: target && { step: target.step ?? null, selectionMode: target.selectionMode || null, canCancel: target.canCancel !== false, selectedTargets: target.selectedTargets || [], candidates: target.candidates || [] },
        overlay: !!document.getElementById('targetOverlay')?.classList.contains('show'),
        puts: window.__RED221_PUTS?.length || 0,
        attack: akaza?.attack ?? null,
        position: akaza && { x: akaza.x, y: akaza.y },
        currentPieceInfoId: typeof currentPieceInfoId !== 'undefined' ? currentPieceInfoId || null : null,
      }
    })()`)

    // The real multistep path must start from a board click.  Close the
    // reading sheet left by the preceding layout checks so its DOM cannot
    // intercept the source-cell hit; retain a debug snapshot if selection
    // still fails so a fixture/coordinate problem is distinguishable from a
    // production target-flow problem.
    await evaluate(`(() => {
      if (typeof closePieceInfo === 'function') closePieceInfo({ restoreFocus: false })
      if (typeof closePieceContextMenu === 'function') closePieceContextMenu()
      if (typeof renderTargetOverlay === 'function') renderTargetOverlay()
      return true
    })()`)
    await delay(120)
    const akazaSourcePoint = await boardPoint({ x: fixture.caster.x, y: fixture.caster.y })
    const akazaSelectionDebug = async () => evaluate(`(() => {
      const point = ${JSON.stringify(akazaSourcePoint)}
      const modal = document.getElementById('pieceInfoModal')
      const menu = document.getElementById('pieceContextMenu')
      const overlay = document.getElementById('targetOverlay')
      const controls = document.getElementById('targetSelectionControls')
      const canvas = document.querySelector('#boardStage3d canvas')
      const rect = element => { const r = element?.getBoundingClientRect(); return r && { left: r.left, top: r.top, width: r.width, height: r.height } }
      const hit = document.elementFromPoint(point.x, point.y)
      const akaza = G?.pieces?.find(piece => piece.instanceId === ${JSON.stringify(setup.akazaId)})
      return {
        point,
        selectedPieceId: selectedPieceId || null,
        screenToCell: battlePresentation?.screenToCell?.(point.x, point.y) || null,
        hit: hit && { tag: hit.tagName, id: hit.id, className: String(hit.className || ''), pointerEvents: getComputedStyle(hit).pointerEvents },
        canvas: rect(canvas),
        akaza: akaza && { id: akaza.instanceId, x: akaza.x, y: akaza.y },
        modal: { rect: rect(modal), display: modal && getComputedStyle(modal).display, dock: !!modal?.classList.contains('character-dock'), pointerEvents: modal && getComputedStyle(modal).pointerEvents },
        menu: { rect: rect(menu), open: !!menu?.classList.contains('is-open'), pointerEvents: menu && getComputedStyle(menu).pointerEvents },
        overlay: { rect: rect(overlay), show: !!overlay?.classList.contains('show'), pointerEvents: overlay && getComputedStyle(overlay).pointerEvents },
        controls: { rect: rect(controls), visible: !!controls && getComputedStyle(controls).display !== 'none' },
        bodyClasses: document.body.className,
      }
    })()`)
    try {
      await tap(akazaSourcePoint, 'mouse')
      await closeTileStatusIfOpen('mouse')
      await waitFor(`selectedPieceId === ${JSON.stringify(setup.akazaId)}`, 5000, 'Akaza caster selection')
    } catch (error) {
      const debug = await akazaSelectionDebug()
      await screenshot('desktop-akaza-caster-selection-failed.png')
      evidence.screenshots.push('desktop-akaza-caster-selection-failed.png')
      throw new Error(`RED-225: real Akaza caster click did not select the configured source piece: ${JSON.stringify({ debug, cause: String(error && error.message || error) })}`)
    }
    await evaluate(`(() => { const button = document.querySelector('.character-cast[data-skill-id="akaza-flash-step"]'); button?.scrollIntoView({ block: 'center', inline: 'nearest' }); return !!button })()`)
    await delay(120)
    try {
      await clickSelector('.character-cast[data-skill-id="akaza-flash-step"]', 'mouse')
      await waitFor(`pendingSkill?.skillId === 'akaza-flash-step' && (pendingSkill.preparation?.candidates?.length > 0 || pendingSkill.validTargets?.size > 0)`, 5000, 'Akaza first target step')
    } catch (error) {
      const debug = await evaluate(`(() => {
        const button = document.querySelector('.character-cast[data-skill-id="akaza-flash-step"]')
        const rect = element => { const r = element?.getBoundingClientRect(); return r && { left: r.left, top: r.top, width: r.width, height: r.height } }
        return {
          selectedPieceId: selectedPieceId || null,
          pendingSkill: pendingSkill && { skillId: pendingSkill.skillId || null, preparation: pendingSkill.preparation || null, validTargets: pendingSkill.validTargets ? Array.from(pendingSkill.validTargets) : null },
          authoritativeTarget: G?.pendingTargetSelection || null,
          button: { exists: !!button, disabled: !!button?.disabled, rect: rect(button), text: button?.textContent?.trim() || '', ariaLabel: button?.getAttribute('aria-label') || null },
          status: document.getElementById('statusMsg')?.textContent || '',
          targetOverlay: { show: !!document.getElementById('targetOverlay')?.classList.contains('show'), text: document.getElementById('targetPromptText')?.textContent || '' },
          controls: { show: !!document.getElementById('targetSelectionControls')?.classList.contains('show') },
        }
      })()`)
      await screenshot('desktop-akaza-first-target-failed.png')
      evidence.screenshots.push('desktop-akaza-first-target-failed.png')
      throw new Error(`RED-225: real Akaza skill did not expose its first target step: ${JSON.stringify({ setup, debug, cause: String(error && error.message || error) })}`)
    }
    const first = await multiFlow('akaza-multi-step-first-target')
    ensure(first.pendingSkill?.skillId === 'akaza-flash-step' && first.target?.step === 0, `RED-225: Akaza did not enter the first real pending target step: ${JSON.stringify(first)}`)

    const visibleOtherDescription = await evaluate(`(() => {
      const descriptions = Array.from(document.querySelectorAll('#pieceInfoContent .pi-skill-desc'))
      const active = document.querySelector('#pieceInfoContent .pi-skill.is-targeting-skill .pi-skill-desc')
      const description = descriptions.find(element => element !== active && (() => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight })())
      if (!description) return null
      const r = description.getBoundingClientRect()
      return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }
    })()`)
    if (visibleOtherDescription) {
      const beforeRead = await multiFlow('akaza-before-other-description-read')
      await mouseAt(visibleOtherDescription)
      const afterRead = await multiFlow('akaza-after-other-description-read')
      ensure(afterRead.pendingSkill?.pendingTargetIndex === beforeRead.pendingSkill?.pendingTargetIndex && afterRead.puts === beforeRead.puts, `RED-225: reading another skill during a multi-step selection changed the pending step: ${JSON.stringify({ beforeRead, afterRead })}`)
    }

    await tap(await boardPoint({ x: setup.target.x, y: setup.target.y }), 'mouse')
    await waitFor(`pendingSkill?.skillId === 'akaza-flash-step' && ((pendingSkill.preparation?.step ?? pendingSkill.pendingTargetIndex ?? 0) >= 1)`, 5000, 'Akaza landing target step')
    const second = await multiFlow('akaza-multi-step-second-grid')
    ensure(second.pendingSkill?.skillId === 'akaza-flash-step' && second.target?.step === 1, `RED-225: Akaza first target did not advance to the real landing step: ${JSON.stringify(second)}`)

    const occupiedLanding = await multiFlow('akaza-second-step-candidates')
    await tap(await boardPoint({ x: setup.relocation.x, y: setup.relocation.y }), 'mouse')
    const rejectedLanding = await multiFlow('akaza-illegal-landing-retry')
    ensure(rejectedLanding.pendingSkill?.skillId === 'akaza-flash-step' && rejectedLanding.target?.step === 1 && rejectedLanding.puts === occupiedLanding.puts, `RED-225: illegal multi-step landing exited or submitted the selection: ${JSON.stringify({ occupiedLanding, rejectedLanding })}`)
    const landing = occupiedLanding.target?.candidates?.find(candidate => (candidate?.type === 'grid' || candidate?.type === 'cell') && !(candidate.x === setup.relocation.x && candidate.y === setup.relocation.y))
    ensure(landing && Number.isFinite(landing.x) && Number.isFinite(landing.y), `RED-225: real Akaza landing step exposed no legal adjacent grid candidate: ${JSON.stringify(occupiedLanding)}`)
    await tap(await boardPoint({ x: landing.x, y: landing.y }), 'mouse')
    await waitFor(`!pendingSkill && !targetSubmissionPending && !G?.pendingTargetSelection`, 7000, 'Akaza multi-step completion')
    const completed = await multiFlow('akaza-multi-step-complete')
    ensure(completed.position?.x === landing.x && completed.position?.y === landing.y && completed.attack === setup.attack + 1, `RED-225: real Akaza multi-step result did not teleport and permanently increase attack: ${JSON.stringify({ landing, completed })}`)
    return { setup, first, second, occupiedLanding, rejectedLanding, landing, completed }
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

  const verifyFloaterStacking = async (name, legacy = false) => {
    // Use the actual public feedback entry; no role data or combat state changes.
    await evaluate(`(() => {
      if (battlePresentation) BattleRenderer3D.settlePresentation(battlePresentation.getModel())
      window.__RED223_PREVIOUS_3D__ = _use3d
      if (${legacy}) _use3d = false
      spawnFloater(8, 8, '−4', '#fff', false, { kind: 'damage' })
      spawnFloater(8, 8, '+2', '#fff', false, { kind: 'heal' })
      spawnFloater(8, 8, '定身', '#fff', false, { kind: 'statusAdded' })
      spawnFloater(9, 8, '−6', '#fff', true, { kind: 'damage' })
      spawnFloater(0, 0, '边缘 −3', '#fff', false, { kind: 'damage' })
      _use3d = window.__RED223_PREVIOUS_3D__
      return true
    })()`)
    await win.webContents.capturePage()
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const samples = []
    for (const elapsed of [160, 450, 1200]) {
      await delay(elapsed - (samples.at(-1)?.elapsed || 0))
      await win.webContents.capturePage()
      const sample = await evaluate(`(() => {
        const layer = document.getElementById('floatLayer').getBoundingClientRect()
        const labels = Array.from(document.querySelectorAll('#floatLayer .dmg-float')).map(el => {
          const r = el.getBoundingClientRect()
          return { text: el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            opacity: Number(getComputedStyle(el).opacity), pointerEvents: getComputedStyle(el).pointerEvents, crowded: el.dataset.floaterCrowded }
        })
        const obstacles = Array.from(document.querySelectorAll('[data-floater-obstacle]')).filter(el => !el.hidden && el.getAttribute('aria-hidden') !== 'true').map(el => {
          const r = el.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }).filter(r => r.width > 0 && r.height > 0)
        return { width: layer.width, height: layer.height, left: layer.left, top: layer.top, labels, obstacles }
      })()`)
      ensure(sample.labels.length === 5, `${name}: expected five separately retained labels: ${JSON.stringify(sample)}`)
      sample.labels.forEach((a, index) => {
        ensure(a.opacity > 0.8 && a.pointerEvents === 'none', `${name}: text is invisible or blocks input: ${JSON.stringify(a)}`)
        ensure(a.left >= sample.left && a.top >= sample.top && a.right <= sample.left + sample.width && a.bottom <= sample.top + sample.height, `${name}: clipped text: ${JSON.stringify(sample)}`)
        sample.labels.slice(index + 1).forEach(b => {
          const separate = a.right + 4 <= b.left || b.right + 4 <= a.left || a.bottom + 4 <= b.top || b.bottom + 4 <= a.top
          ensure(separate, `${name}: animated text overlap at ${elapsed}ms: ${JSON.stringify({ a, b })}`)
        })
        sample.obstacles.forEach(b => {
          ensure(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${name}: HUD prompt covers floating text: ${JSON.stringify({ a, b })}`)
        })
      })
      samples.push({ elapsed, ...sample })
      if (elapsed === 450) {
        await screenshot(`${name}.png`)
        evidence.screenshots.push(`${name}.png`)
        if (legacy) win.setContentSize(1024, 600)
      }
      if (legacy && elapsed === 1200) {
        await screenshot(`${name}-resized.png`)
        evidence.screenshots.push(`${name}-resized.png`)
      }
    }
    await delay(1100)
    ensure(await evaluate(`document.querySelectorAll('#floatLayer .dmg-float').length === 0`), `${name}: expired text retained`)
    evidence.floaterStacking = evidence.floaterStacking || {}
    evidence.floaterStacking[name] = { samples, cleaned: true }
    if (legacy) { win.setContentSize(1280, 720); await delay(200) }
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
        first: choose('trainingFirstPieces', ['red-venom', 'dark-muzan', 'dark-akaza']),
        second: choose('trainingSecondPieces', ['uther', 'anduin']),
        firstFaction: document.getElementById('trainingFirstFaction')?.value,
        secondFaction: document.getElementById('trainingSecondFaction')?.value,
      }
    })()`)
    ensure(setup.first.found.length >= 3 && setup.second.found.length === 2, `Training fixture pieces missing: ${JSON.stringify(setup)}`)
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
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      evidence.layout = await verifySkillLayout(fixture)
      await screenshot('desktop-1280x720-skill-layout-restored.png')
      evidence.screenshots.push('desktop-1280x720-skill-layout-restored.png')
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
    if (process.env.RVB_DOM_REUSE === '1') {
      evidence.domReuse = await evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(skillSelector)})
        const hosts = ['pieceContextSkills', 'playerResCards', 'resApTrack', 'myPieces', 'oppPieces']
          .map(id => document.getElementById(id)).filter(Boolean)
        const before = hosts.map(host => Array.from(host.children))
        const descendants = hosts.map(host => Array.from(host.querySelectorAll('*')))
        button.focus({ preventScroll: true })
        for (let index = 0; index < 5; index++) render()
        return {
          focusPreserved: document.activeElement === button,
          rootIdentity: hosts.every((host, index) => before[index].length === host.children.length && before[index].every((node, i) => node === host.children[i])),
          subtreeIdentity: hosts.every((host, index) => { const nodes = Array.from(host.querySelectorAll('*')); return descendants[index].length === nodes.length && descendants[index].every((node, i) => node === nodes[i]) }),
        }
      })()`)
      ensure(evidence.domReuse.focusPreserved && evidence.domReuse.rootIdentity && evidence.domReuse.subtreeIdentity,
        'Battle hot DOM hosts were rebuilt: ' + JSON.stringify(evidence.domReuse))
    }
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
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      const targetingLayout = await inspectSkillLayout('desktop-targeting-layout')
      const targetControls = await inspectTargetControls('desktop-target-controls')
      ensure(targetingLayout.modal.visible && targetingLayout.rows.length === targetingLayout.displaySkillCount, `RED-225: target mode replaced or hid the skill list: ${JSON.stringify(targetingLayout)}`)
      ensure(targetingLayout.rows.every(row => row.text && row.descriptionVisible), `RED-225: target mode made another skill description unreadable: ${JSON.stringify(targetingLayout)}`)
      ensure(targetingLayout.rows.filter(row => row.ariaCurrent === 'true').length === 1 && targetingLayout.rows.find(row => row.ariaCurrent === 'true')?.cast?.ariaLabel?.includes('利爪撕裂'), `RED-225: target mode did not mark the active skill in the retained list: ${JSON.stringify(targetingLayout)}`)
      ensure(targetControls.overlay.visible && targetControls.prompt.visible && targetControls.prompt.text, `RED-225: top target prompt is not visible while selecting: ${JSON.stringify(targetControls)}`)
      ensure(targetControls.prompt.rect && targetControls.prompt.rect.top >= 0 && targetControls.prompt.rect.top <= Math.max(120, targetControls.viewport.height * 0.35) && targetControls.prompt.rect.height <= 64, `RED-225: target prompt is not a short top-of-screen line: ${JSON.stringify(targetControls)}`)
      ensure(targetControls.controls.visible && targetControls.controls.insideDock && !targetControls.controls.insideOverlay, `RED-225: target controls are not separated into the character sheet: ${JSON.stringify(targetControls)}`)
      assertTargetPresentation(targetControls, 'RED-225 desktop target presentation')
      ensure(targetControls.cancel.exists && targetControls.cancel.visible && !targetControls.cancel.hidden && targetControls.cancel.rect && targetControls.cancel.rect.height >= 48 && targetControls.cancel.rect.bottom <= targetControls.viewport.height + 1, `RED-225: target cancel is not a reachable skill-panel action: ${JSON.stringify(targetControls)}`)
      ensure(!targetControls.independentCard, `RED-225: target prompt still uses the independent target-mode card: ${JSON.stringify(targetControls)}`)
      const focusRetention = await evaluate(`(() => {
        const button = document.getElementById('targetCancelButton')
        if (!button) return { supported: false }
        button.focus({ preventScroll: true })
        const before = document.activeElement === button
        if (typeof renderTargetOverlay === 'function') renderTargetOverlay()
        const after = document.activeElement === button
        return { supported: true, before, after, activeId: document.activeElement?.id || null }
      })()`)
      ensure(focusRetention.supported && focusRetention.before && focusRetention.after, `RED-225: re-rendering target controls lost focus from the cancel action: ${JSON.stringify(focusRetention)}`)
      evidence.layout = { ...(evidence.layout || {}), targeting: targetingLayout, targetControls }
      evidence.layout.focusRetention = focusRetention
      await screenshot('desktop-1280x720-skill-layout-targeting.png')
      evidence.screenshots.push('desktop-1280x720-skill-layout-targeting.png')
    }
    evidence.desktop = { setup, fixture, selected, armed }
    if (process.env.RVB_SKILL_PREVIEW === '1') {
      const original = await evaluate('JSON.stringify(G)')
      const target = await boardPoint(fixture.validTarget)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
      await waitFor('skillPreviewController && skillPreviewController.getDiagnostics().active?.displayed', 5000, 'real skill preview')
      const preview = await evaluate(`({ diagnostics: skillPreviewController.getDiagnostics(),
        badge: document.querySelector('.skill-preview-badge')?.textContent,
        floaters: Array.from(document.querySelectorAll('#floatLayer [data-preview="true"]')).map(e => e.textContent),
        displayTimings: skillPreviewDisplayTimings, sameState: JSON.stringify(G) === ${JSON.stringify(original)},
        puts: window.__RED221_PUTS.length, history: G.presentationEvents.length })`)
      ensure(preview.diagnostics.requests.at(-1)?.status === 'ready', `Real skill cannot preview: ${JSON.stringify(preview)}`)
      ensure(preview.sameState && preview.puts === 0 && preview.floaters.some(text => /−/.test(text)), `Preview changed authority or omitted damage: ${JSON.stringify(preview)}`)
      await screenshot('desktop-skill-hypothetical.png')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1270, y: 10 })
      await waitFor('!skillPreviewController.getDiagnostics().active', 5000, 'preview leave restoration')
      ensure(await evaluate(`JSON.stringify(G) === ${JSON.stringify(original)}`), 'Leaving preview changed real state')
      const benchmark = await evaluate(`(() => {
        const action = Object.assign({}, pendingSkill.baseAction)
        _appendTargetToAction(action, G.pieces.find(p => p.instanceId === __RED221_FIXTURE__.validTargetId),
          __RED221_FIXTURE__.validTarget.x, __RED221_FIXTURE__.validTarget.y, pendingSkill.preparation.targetType)
        const times = []
        for (let i = 0; i < 100; i++) {
          const result = GameEngine.previewBattleAction(G, action, myPlayerId)
          if (result.status !== 'ready') throw new Error('Benchmark preview not ready')
          times.push(result.durationMs)
        }
        times.sort((a,b) => a-b)
        return { samples: times.length, p50: times[49], p95: times[94], worst: times[99], sameState: JSON.stringify(G) === ${JSON.stringify(original)} }
      })()`)
      ensure(benchmark.sameState, 'Repeated previews changed authority')
      evidence.preview = { preview, benchmark }
    }
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
    if (process.env.RVB_FEEDBACK_LATENCY === '1') await require('./red224-feedback-latency.cjs').install(evaluate)
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
    if (process.env.RVB_FEEDBACK_LATENCY === '1') {
      evidence.desktop.feedbackLatency = await require('./red224-feedback-latency.cjs').finish(evaluate, waitFor)
    }
    if (process.env.RVB_COMPACT_FLOATERS === '1') {
      await delay(3100)
      const compact = await evaluate(`(() => {
        for (const text of ['−4', '−2', '+3', '定身']) BattleRenderer3D.spawnFloater(
          Math.floor(G.map.width / 2), Math.floor(G.map.height / 2), text, '#fff', false)
        return Array.from(document.querySelectorAll('.dmg-float')).map(el => ({
          text: el.textContent, x: parseFloat(el.style.left), y: parseFloat(el.style.top),
          width: el.offsetWidth, height: el.offsetHeight, crowded: el.dataset.floaterCrowded,
        }))
      })()`)
      ensure(compact.length === 4, 'Compact floaters dropped a result')
      const ordered = compact.slice().sort((a, b) => a.y - b.y)
      const gaps = ordered.slice(1).map((entry, i) => entry.y - ordered[i].y)
      ensure(gaps.every(gap => gap > 0 && gap <= 60), 'Same-point floaters remain excessively spread: ' + JSON.stringify(compact))
      evidence.desktop.compactFloaters = { entries: compact, centerGaps: gaps }
      await win.webContents.capturePage()
      await delay(150)
      await screenshot('desktop-compact-floaters.png')
      evidence.screenshots.push('desktop-compact-floaters.png')
    }

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
    if (process.env.RVB_SKILL_PREVIEW === '1') {
      evidence.desktop.touchDrag = await require('./red224-skill-drag-smoke.cjs')({
        cdp, delay, evaluate, fixtureInstaller, tap, boardPoint, closeTileStatusIfOpen,
        skillSelector, pointFor, snapshot, ensure, waitFor,
      })
    }

    if (process.env.RVB_FLOATER_STACKING === '1') {
      await delay(2200)
      await verifyFloaterStacking('desktop-floater-stacking')
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await verifyFloaterStacking('desktop-reduced-floater-stacking')
      await cdp('Emulation.setEmulatedMedia', { features: [] })
      await verifyFloaterStacking('desktop-legacy-floater-stacking', true)
    }

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

    if (process.env.RVB_SKILL_LAYOUT === '1') {
      evidence.multiStep = await verifyAkazaMultiStep(fixture)
    }

    // Mobile landscape: repeat the invalid occupied/empty target checks with
    // actual touch events, capture the requested 844x390 frame, then cancel.
    win.setContentSize(844, 390)
    await delay(350)
    await evaluate(fixtureInstaller)
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      await evaluate(`(() => { if (typeof closePieceInfo === 'function') closePieceInfo({ restoreFocus: false }); if (typeof closePieceContextMenu === 'function') closePieceContextMenu(); return true })()`)
      await delay(100)
    }
    const mobileCasterPoint = await boardPoint(fixture.caster)
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      await screenshot('mobile-844x390-before-caster-touch.png')
      evidence.screenshots.push('mobile-844x390-before-caster-touch.png')
    }
    await tap(mobileCasterPoint, 'touch')
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      await delay(120)
      const mobileSelectionDebug = await evaluate(`(() => {
        const point = ${JSON.stringify(mobileCasterPoint)}
        const modal = document.getElementById('pieceInfoModal')
        const menu = document.getElementById('pieceContextMenu')
        const canvas = document.querySelector('#boardStage3d canvas')
        const rect = element => { const r = element?.getBoundingClientRect(); return r && { left: r.left, top: r.top, width: r.width, height: r.height } }
        const hit = document.elementFromPoint(point.x, point.y)
        return {
          point,
          selectedPieceId: selectedPieceId || null,
          screenToCell: battlePresentation?.screenToCell?.(point.x, point.y) || null,
          hit: hit && { tag: hit.tagName, id: hit.id, className: String(hit.className || ''), pointerEvents: getComputedStyle(hit).pointerEvents },
          canvas: rect(canvas),
          modal: { rect: rect(modal), display: modal && getComputedStyle(modal).display, dock: !!modal?.classList.contains('character-dock'), pointerEvents: modal && getComputedStyle(modal).pointerEvents },
          sheet: rect(modal?.querySelector('.pi-sheet')),
          menu: { rect: rect(menu), open: !!menu?.classList.contains('is-open'), pointerEvents: menu && getComputedStyle(menu).pointerEvents },
          bodyClasses: document.body.className,
        }
      })()`)
      evidence.mobile.selectionDebug = mobileSelectionDebug
      if (mobileSelectionDebug.selectedPieceId !== fixture.casterId) {
        await screenshot('mobile-844x390-caster-touch-failed.png')
        evidence.screenshots.push('mobile-844x390-caster-touch-failed.png')
        throw new Error(`RED-225: normal mobile touch did not select the caster before skill release: ${JSON.stringify(mobileSelectionDebug)}`)
      }
    }
    await closeTileStatusIfOpen('touch')
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      await waitFor('document.getElementById("pieceInfoModal")?.classList.contains("character-dock") === true && document.querySelectorAll("#pieceInfoContent .pi-skill").length >= 3', 5000, 'mobile character sheet')
      await waitFor(`selectedPieceId === ${JSON.stringify(fixture.casterId)}`, 5000, 'mobile caster selection')
      await evaluate(`(() => { const button = document.querySelector(${JSON.stringify(skillSelector)}); button?.scrollIntoView({ block: 'center', inline: 'nearest' }); return !!button })()`)
      await delay(120)
      await clickSelector(skillSelector, 'touch')
    } else {
      await clickSelector('#mobileSkillsToggle', 'touch')
      await waitFor('document.getElementById("pieceContextMenu")?.classList.contains("is-open") === true', 5000, 'mobile skill dock')
      await clickSelector('.piece-context-skill[data-skill-id="venom-claw-rend"]', 'touch')
    }
    const mobileArmed = await snapshot('mobile-after-skill-touch')
    await tap(await boardPoint(fixture.invalidPiece), 'touch')
    const mobileOccupiedRejected = await snapshot('mobile-after-invalid-occupied-touch')
    await tap(await boardPoint(fixture.empty), 'touch')
    const mobileEmptyRejected = await snapshot('mobile-after-invalid-empty-touch')
    ensure(mobileArmed.pendingSkill?.skillId === 'venom-claw-rend', `Mobile touch did not arm the skill: ${JSON.stringify(mobileArmed)}`)
    ensure(mobileOccupiedRejected.selectedPieceId === fixture.casterId && mobileOccupiedRejected.pendingSkill?.skillId === 'venom-claw-rend', `Mobile occupied target changed the draft: ${JSON.stringify(mobileOccupiedRejected)}`)
    ensure(mobileEmptyRejected.selectedPieceId === fixture.casterId && mobileEmptyRejected.pendingSkill?.skillId === 'venom-claw-rend', `Mobile empty target changed the draft: ${JSON.stringify(mobileEmptyRejected)}`)
    if (process.env.RVB_SKILL_LAYOUT === '1') {
      const mobileLayout = await inspectSkillLayout('mobile-landscape-targeting-layout')
      const mobileTargetControls = await inspectTargetControls('mobile-landscape-target-controls')
      ensure(mobileLayout.modal.visible && mobileLayout.pieceId === fixture.casterId && mobileLayout.rows.length === mobileLayout.displaySkillCount && mobileLayout.rows.every(row => row.text && row.descriptionVisible), `RED-225: mobile landscape target mode lost the current piece's readable skill descriptions: ${JSON.stringify(mobileLayout)}`)
      ensure(mobileLayout.rows.filter(row => row.ariaCurrent === 'true').length === 1 && mobileLayout.rows.find(row => row.ariaCurrent === 'true')?.cast?.ariaLabel?.includes('利爪撕裂'), `RED-225: mobile landscape did not mark the active skill in the retained list: ${JSON.stringify(mobileLayout)}`)
      ensure(mobileTargetControls.overlay.visible && mobileTargetControls.prompt.visible && mobileTargetControls.prompt.text, `RED-225: mobile landscape top target prompt is not visible: ${JSON.stringify(mobileTargetControls)}`)
      ensure(mobileTargetControls.prompt.rect && mobileTargetControls.prompt.rect.top >= 0 && mobileTargetControls.prompt.rect.top <= Math.max(120, mobileTargetControls.viewport.height * 0.35) && mobileTargetControls.prompt.rect.height <= 64, `RED-225: mobile landscape target prompt is not a short top line: ${JSON.stringify(mobileTargetControls)}`)
      ensure(mobileTargetControls.controls.visible && mobileTargetControls.controls.insideDock && !mobileTargetControls.controls.insideOverlay, `RED-225: mobile landscape target controls are not separated into the character sheet: ${JSON.stringify(mobileTargetControls)}`)
      assertTargetPresentation(mobileTargetControls, 'RED-225 mobile landscape target presentation')
      ensure(mobileTargetControls.cancel.exists && mobileTargetControls.cancel.visible && !mobileTargetControls.cancel.hidden && mobileTargetControls.cancel.rect && mobileTargetControls.cancel.rect.height >= 48 && mobileTargetControls.cancel.rect.bottom <= mobileTargetControls.viewport.height + 1, `RED-225: mobile landscape cancel is not reachable in the skill panel: ${JSON.stringify(mobileTargetControls)}`)
      ensure(!mobileTargetControls.independentCard && mobileTargetControls.viewport.scrollWidth <= mobileTargetControls.viewport.width + 1, `RED-225: mobile landscape target prompt or controls still use the old card/overflow: ${JSON.stringify(mobileTargetControls)}`)
      evidence.mobile.layout = { mobileLayout, mobileTargetControls }
    }
    await screenshot('mobile-844x390-target-retry.png')
    evidence.screenshots.push('mobile-844x390-target-retry.png')
    const mobileCancelBefore = await evaluate(`(() => ({
      pendingTargetSelection: G?.pendingTargetSelection || null,
      pendingOptionSelection: G?.pendingOptionSelection || null,
      locallyCancelledSelectionId: typeof locallyCancelledSelectionId !== 'undefined' ? locallyCancelledSelectionId || null : null,
      controls: { show: !!document.getElementById('targetSelectionControls')?.classList.contains('show'), disabled: !!document.getElementById('targetCancelButton')?.disabled },
      input: (() => {
        const button = document.getElementById('targetCancelButton')
        const rect = button?.getBoundingClientRect()
        const point = rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        const hit = point && document.elementFromPoint(point.x, point.y)
        window.__RED225_CANCEL_EVENTS = []
        for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
          const target = event.target
          window.__RED225_CANCEL_EVENTS.push({ type, target: target && { tag: target.tagName, id: target.id, className: String(target.className || '') }, defaultPrevented: event.defaultPrevented })
        }, { capture: true, once: false })
        return { point, button: rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: getComputedStyle(button).pointerEvents }, hit: hit && { tag: hit.tagName, id: hit.id, className: String(hit.className || ''), pointerEvents: getComputedStyle(hit).pointerEvents } }
      })(),
    }))()`)
    ensure(mobileCancelBefore.input?.hit?.id === 'targetCancelButton', `RED-225: mobile target cancel is visually present but hit-tested by another layer: ${JSON.stringify(mobileCancelBefore)}`)
    await clickSelector('#targetCancelButton', 'touch')
    const mobileCancelled = await snapshot('mobile-after-explicit-cancel-touch')
    const mobileCancelAfter = await evaluate(`(() => ({
      pendingTargetSelection: G?.pendingTargetSelection || null,
      pendingOptionSelection: G?.pendingOptionSelection || null,
      events: window.__RED225_CANCEL_EVENTS || [],
      status: document.getElementById('statusMsg')?.textContent || '',
    }))()`)
    ensure(mobileCancelled.selectedPieceId === fixture.casterId && !mobileCancelled.pendingSkill && !mobileCancelled.targetOverlay && !mobileCancelled.targetMode, `Mobile touch cancel did not exit target mode: ${JSON.stringify({ mobileCancelBefore, mobileCancelled, mobileCancelAfter })}`)
    evidence.mobile = { ...(evidence.mobile || {}), mobileArmed, mobileOccupiedRejected, mobileEmptyRejected, mobileCancelled }

    if (process.env.RVB_SKILL_LAYOUT === '1') {
      // Closing the reading sheet is an explicit user choice. Opening the
      // mobile hand afterward must not reopen that sheet as a side effect.
      await evaluate(`(() => {
        if (typeof closePieceInfo === 'function') closePieceInfo({ restoreFocus: false })
        if (typeof closePieceContextMenu === 'function') closePieceContextMenu()
        return true
      })()`)
      await delay(120)
      const closedSheet = await evaluate(`(() => {
        const modal = document.getElementById('pieceInfoModal')
        return { visible: !!modal && getComputedStyle(modal).display !== 'none', dock: !!modal?.classList.contains('character-dock'), bodyDockOpen: document.body.classList.contains('character-dock-open') }
      })()`)
      ensure(!closedSheet.visible && !closedSheet.bodyDockOpen, `RED-225: explicit character-sheet close did not stay closed before hand interaction: ${JSON.stringify(closedSheet)}`)
      await clickSelector('#mobileHandToggle', 'touch')
      await delay(160)
      const handAfterClosedSheet = await evaluate(`(() => {
        const modal = document.getElementById('pieceInfoModal')
        const hand = document.getElementById('handCards')
        return { visible: !!modal && getComputedStyle(modal).display !== 'none', dock: !!modal?.classList.contains('character-dock'), bodyDockOpen: document.body.classList.contains('character-dock-open'), handExpanded: document.body.classList.contains('mobile-hand-expanded'), handVisibility: hand ? getComputedStyle(hand).visibility : null }
      })()`)
      ensure(!handAfterClosedSheet.visible && !handAfterClosedSheet.bodyDockOpen, `RED-225: opening mobile hand unexpectedly reopened the closed character sheet: ${JSON.stringify({ closedSheet, handAfterClosedSheet })}`)
      evidence.mobile.closedSheetHand = { closedSheet, handAfterClosedSheet }
      await clickSelector('#mobileHandToggle', 'touch')
      await delay(120)
    }

    if (process.env.RVB_SKILL_LAYOUT === '1') {
      // Portrait is a separate acceptance target.  Use the same real touch
      // path, adapting to either the persistent sheet button or the existing
      // compact mobile skill dock, whichever the responsive layout exposes.
      win.setContentSize(390, 844)
      await delay(300)
      await evaluate(fixtureInstaller)
      await evaluate(`(() => { if (typeof closePieceInfo === 'function') closePieceInfo({ restoreFocus: false }); if (typeof closePieceContextMenu === 'function') closePieceContextMenu(); return true })()`)
      const portraitCasterPoint = await boardPoint(fixture.caster)
      await screenshot('mobile-390x844-before-caster-touch.png')
      evidence.screenshots.push('mobile-390x844-before-caster-touch.png')
      await tap(portraitCasterPoint, 'touch')
      await delay(120)
      const portraitSelectionDebug = await evaluate(`(() => {
        const point = ${JSON.stringify(portraitCasterPoint)}
        const modal = document.getElementById('pieceInfoModal')
        const menu = document.getElementById('pieceContextMenu')
        const canvas = document.querySelector('#boardStage3d canvas')
        const topbar = document.querySelector('.topbar')
        const boardWrap = document.getElementById('boardWrap')
        const tileStatusPanel = document.getElementById('tileStatusPanel')
        const describe = element => {
          const r = element?.getBoundingClientRect()
          const s = element ? getComputedStyle(element) : null
          return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, display: s.display, position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, overflow: s.overflow, cssTop: s.top, cssRight: s.right, cssBottom: s.bottom, cssLeft: s.left, transform: s.transform }
        }
        const rect = element => { const r = element?.getBoundingClientRect(); return r && { left: r.left, top: r.top, width: r.width, height: r.height } }
        const hit = document.elementFromPoint(point.x, point.y)
        return {
          point,
          selectedPieceId: selectedPieceId || null,
          screenToCell: battlePresentation?.screenToCell?.(point.x, point.y) || null,
          hit: hit && { tag: hit.tagName, id: hit.id, className: String(hit.className || ''), pointerEvents: getComputedStyle(hit).pointerEvents },
          hitStack: document.elementsFromPoint(point.x, point.y).slice(0, 10).map(element => ({ tag: element.tagName, id: element.id || '', className: String(element.className || ''), pointerEvents: getComputedStyle(element).pointerEvents, zIndex: getComputedStyle(element).zIndex })),
          canvas: rect(canvas),
          canvasComputed: describe(canvas),
          topbar: describe(topbar),
          boardWrap: describe(boardWrap),
          tileStatusPanel: describe(tileStatusPanel),
          modal: { rect: rect(modal), display: modal && getComputedStyle(modal).display, dock: !!modal?.classList.contains('character-dock'), pointerEvents: modal && getComputedStyle(modal).pointerEvents },
          sheet: rect(modal?.querySelector('.pi-sheet')),
          menu: { rect: rect(menu), open: !!menu?.classList.contains('is-open'), pointerEvents: menu && getComputedStyle(menu).pointerEvents },
          bodyClasses: document.body.className,
        }
      })()`)
      evidence.mobile.portraitSelectionDebug = portraitSelectionDebug
      if (portraitSelectionDebug.selectedPieceId !== fixture.casterId) {
        await screenshot('mobile-390x844-caster-touch-failed.png')
        evidence.screenshots.push('mobile-390x844-caster-touch-failed.png')
        throw new Error(`RED-225: normal portrait touch did not select the caster before skill release: ${JSON.stringify(portraitSelectionDebug)}`)
      }
      await closeTileStatusIfOpen('touch')
      // In portrait the persistent sheet may contain more skills than fit in
      // the viewport. Scroll its real touch surface before resolving the
      // action point; never dispatch a synthetic tap outside the viewport.
      const portraitScroll = { initial: null, swipes: [], after: null }
      const portraitSkillView = () => evaluate(`(() => {
        const sheet = document.querySelector('#pieceInfoModal.character-dock .pi-sheet')
        const button = document.querySelector('.character-cast[data-skill-id="venom-claw-rend"]')
        const sheetRect = sheet?.getBoundingClientRect()
        const buttonRect = button?.getBoundingClientRect()
        const visible = !!buttonRect && buttonRect.width > 0 && buttonRect.height > 0 && buttonRect.top >= 0 && buttonRect.bottom <= innerHeight
        return {
          visible,
          scrollTop: sheet?.scrollTop || 0,
          scrollHeight: sheet?.scrollHeight || 0,
          clientHeight: sheet?.clientHeight || 0,
          sheetRect: sheetRect && { left: sheetRect.left, top: sheetRect.top, right: sheetRect.right, bottom: sheetRect.bottom, width: sheetRect.width, height: sheetRect.height },
          buttonRect: buttonRect && { left: buttonRect.left, top: buttonRect.top, right: buttonRect.right, bottom: buttonRect.bottom, width: buttonRect.width, height: buttonRect.height },
          sheetPointerEvents: sheet ? getComputedStyle(sheet).pointerEvents : null,
          sheetTouchAction: sheet ? getComputedStyle(sheet).touchAction : null,
        }
      })()`)
      portraitScroll.initial = await portraitSkillView()
      let currentPortraitSkillView = portraitScroll.initial
      for (let attempt = 0; attempt < 4 && !currentPortraitSkillView.visible; attempt += 1) {
        const sheet = currentPortraitSkillView.sheetRect
        ensure(sheet && sheet.width > 0 && sheet.height > 0, `RED-225: portrait skill sheet has no touchable viewport for scrolling: ${JSON.stringify(currentPortraitSkillView)}`)
        const x = Math.round(sheet.left + sheet.width / 2)
        const startY = Math.round(Math.min(sheet.bottom - 24, Math.max(sheet.top + 40, sheet.top + sheet.height * 0.76)))
        const endY = Math.round(Math.max(sheet.top + 24, startY - Math.min(260, Math.max(120, sheet.height * 0.72))))
        await touchSwipe({ x, y: startY }, { x, y: endY })
        const after = await portraitSkillView()
        portraitScroll.swipes.push({ attempt: attempt + 1, start: { x, y: startY }, end: { x, y: endY }, after })
        currentPortraitSkillView = after
      }
      portraitScroll.after = currentPortraitSkillView
      evidence.mobile.portraitScroll = portraitScroll
      ensure(portraitScroll.after.visible, `RED-225: real portrait touch scroll did not bring the selected skill into the viewport: ${JSON.stringify(portraitScroll)}`)
      const portraitAction = await evaluate(`(() => {
        const describe = element => {
          const r = element?.getBoundingClientRect()
          const s = element ? getComputedStyle(element) : null
          const center = r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          const hit = center && document.elementFromPoint(center.x, center.y)
          return element && { disabled: !!element.disabled, rect: r && { left: r.left, top: r.top, width: r.width, height: r.height }, display: s.display, visibility: s.visibility, pointerEvents: s.pointerEvents, ariaLabel: element.getAttribute('aria-label') || '', center, hit: hit && { tag: hit.tagName, id: hit.id || '', className: String(hit.className || ''), pointerEvents: getComputedStyle(hit).pointerEvents } }
        }
        const direct = Array.from(document.querySelectorAll('.character-cast[data-skill-id="venom-claw-rend"]')).find(element => {
          const r = element.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && !element.disabled
        })
        if (direct) return { kind: 'direct', selector: '.character-cast[data-skill-id="venom-claw-rend"]', direct: describe(direct) }
        const toggle = document.getElementById('mobileSkillsToggle')
        const toggleRect = toggle?.getBoundingClientRect()
        if (toggle && toggleRect && toggleRect.width > 0 && toggleRect.height > 0) return { kind: 'dock', selector: '#mobileSkillsToggle', toggle: describe(toggle) }
        const cast = Array.from(document.querySelectorAll('.character-cast[data-skill-id="venom-claw-rend"]')).map(element => {
          const r = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return { disabled: !!element.disabled, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents, ariaLabel: element.getAttribute('aria-label') || '' }
        })
        const toggleStyle = toggle ? getComputedStyle(toggle) : null
        const context = document.getElementById('pieceContextMenu')
        const contextStyle = context ? getComputedStyle(context) : null
        return { kind: null, cast, toggle: toggle && { hidden: !!toggle.hidden, rect: toggleRect && { left: toggleRect.left, top: toggleRect.top, width: toggleRect.width, height: toggleRect.height }, display: toggleStyle?.display || null, visibility: toggleStyle?.visibility || null, pointerEvents: toggleStyle?.pointerEvents || null }, context: context && { open: context.classList.contains('is-open'), rect: (() => { const r = context.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })(), display: contextStyle?.display || null, visibility: contextStyle?.visibility || null, pointerEvents: contextStyle?.pointerEvents || null }, sheetPointerEvents: getComputedStyle(document.getElementById('pieceInfoModal') || document.body).pointerEvents }
      })()`)
      evidence.mobile.portraitActionDebug = portraitAction
      if (!portraitAction?.kind) {
        await screenshot('mobile-390x844-portrait-action-unavailable.png')
        evidence.screenshots.push('mobile-390x844-portrait-action-unavailable.png')
        throw new Error(`RED-225: portrait exposed neither an enabled skill action nor the compact skill dock: ${JSON.stringify(portraitAction)}`)
      }
      if (portraitAction?.kind === 'dock') {
        await clickSelector('#mobileSkillsToggle', 'touch')
        await waitFor('document.getElementById("pieceContextMenu")?.classList.contains("is-open") === true', 5000, 'portrait skill dock')
        await clickSelector('.piece-context-skill[data-skill-id="venom-claw-rend"]', 'touch')
      } else {
        ensure(portraitAction?.kind === 'direct', `RED-225: portrait offered neither a persistent skill action nor the compact skill dock: ${JSON.stringify(portraitAction)}`)
        await clickSelector('.character-cast[data-skill-id="venom-claw-rend"]', 'touch')
      }
      const portraitArmed = await snapshot('portrait-after-skill-touch')
      evidence.mobile.portraitAfterActionDebug = await evaluate(`(() => {
        const button = document.querySelector('.character-cast[data-skill-id="venom-claw-rend"]')
        const r = button?.getBoundingClientRect()
        const center = r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        const hit = center && document.elementFromPoint(center.x, center.y)
        const menu = document.getElementById('pieceContextMenu')
        const menuStyle = menu && getComputedStyle(menu)
        const menuRect = menu?.getBoundingClientRect()
        const modal = document.getElementById('pieceInfoModal')
        const modalStyle = modal && getComputedStyle(modal)
        const modalRect = modal?.getBoundingClientRect()
        return { button: button && { disabled: !!button.disabled, rect: r && { left: r.left, top: r.top, width: r.width, height: r.height }, active: document.activeElement === button }, center, hit: hit && { tag: hit.tagName, id: hit.id || '', className: String(hit.className || ''), pointerEvents: getComputedStyle(hit).pointerEvents }, menu: menu && { open: menu.classList.contains('is-open'), rect: menuRect && { left: menuRect.left, top: menuRect.top, width: menuRect.width, height: menuRect.height }, display: menuStyle.display, pointerEvents: menuStyle.pointerEvents }, sheet: modal && { display: modalStyle.display, pointerEvents: modalStyle.pointerEvents, rect: modalRect && { left: modalRect.left, top: modalRect.top, width: modalRect.width, height: modalRect.height } } }
      })()`)
      ensure(portraitArmed.pendingSkill?.skillId === 'venom-claw-rend', `RED-225: portrait touch did not arm the skill: ${JSON.stringify(portraitArmed)}`)
      const portraitLayout = await inspectSkillLayout('mobile-portrait-targeting-layout')
      const portraitTargetControls = await inspectTargetControls('mobile-portrait-target-controls')
      ensure(portraitLayout.modal.visible && portraitLayout.rows.length === portraitLayout.displaySkillCount && portraitLayout.rows.every(row => row.text && row.descriptionVisible), `RED-225: mobile portrait target mode lost readable skill descriptions: ${JSON.stringify(portraitLayout)}`)
      ensure(portraitTargetControls.overlay.visible && portraitTargetControls.prompt.visible && portraitTargetControls.prompt.text, `RED-225: mobile portrait top target prompt is not visible: ${JSON.stringify(portraitTargetControls)}`)
      ensure(portraitTargetControls.prompt.rect && portraitTargetControls.prompt.rect.top >= 0 && portraitTargetControls.prompt.rect.top <= Math.max(120, portraitTargetControls.viewport.height * 0.35) && portraitTargetControls.prompt.rect.height <= 64, `RED-225: mobile portrait target prompt is not a short top line: ${JSON.stringify(portraitTargetControls)}`)
      ensure(portraitTargetControls.controls.visible && portraitTargetControls.controls.insideDock && !portraitTargetControls.controls.insideOverlay, `RED-225: mobile portrait target controls are not separated into the character sheet: ${JSON.stringify(portraitTargetControls)}`)
      assertTargetPresentation(portraitTargetControls, 'RED-225 mobile portrait target presentation')
      ensure(portraitTargetControls.cancel.exists && portraitTargetControls.cancel.visible && !portraitTargetControls.cancel.hidden && portraitTargetControls.cancel.rect && portraitTargetControls.cancel.rect.height >= 48 && portraitTargetControls.cancel.rect.bottom <= portraitTargetControls.viewport.height + 1, `RED-225: mobile portrait cancel is not reachable in the skill panel: ${JSON.stringify(portraitTargetControls)}`)
      ensure(!portraitTargetControls.independentCard && portraitTargetControls.viewport.scrollWidth <= portraitTargetControls.viewport.width + 1, `RED-225: mobile portrait target prompt or controls still use the old card/overflow: ${JSON.stringify(portraitTargetControls)}`)
      await screenshot('mobile-390x844-skill-layout-targeting.png')
      evidence.screenshots.push('mobile-390x844-skill-layout-targeting.png')
      await clickSelector('#targetCancelButton', 'touch')
      evidence.mobile.portrait = { portraitAction, portraitArmed, portraitLayout, portraitTargetControls, cancelled: await snapshot('portrait-after-cancel') }
      win.setContentSize(1280, 720)
      await delay(250)
    }

    if (process.env.RVB_FLOATER_STACKING === '1') {
      await verifyFloaterStacking('mobile-floater-stacking')
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await verifyFloaterStacking('mobile-reduced-floater-stacking')
      await cdp('Emulation.setEmulatedMedia', { features: [] })
    }

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
