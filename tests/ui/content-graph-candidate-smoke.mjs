import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const entryUrl = 'http://127.0.0.1:8875/battle.html?mode=training'
let debugPort = 19528
const outputDir = path.join(root, 'output/qa')
const screenshotTarget = path.join(outputDir, 'red252-candidate-ui-target-visible.png')
const screenshotSettlement = path.join(outputDir, 'red252-candidate-ui-settlement-visible.png')
const screenshotAnimation = path.join(outputDir, 'red252-candidate-ui-animation-visible.png')
const reportPath = path.join(outputDir, 'red252-candidate-ui-visible.json')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let child = null
let shuttingDown = false
let shutdownChild = () => {}

async function pickDebugPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a local CDP port')
  const port = address.port
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return port
}

if (!process.versions.electron) {
  debugPort = await pickDebugPort()
  const temporaryProfile = mkdtempSync(path.join(tmpdir(), 'rvb-red252-ui-'))
  const electron = createRequire(import.meta.url)('electron')
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${temporaryProfile}`,
    '--disable-gpu',
    '--no-sandbox',
    fileURLToPath(import.meta.url),
  ], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => process.stdout.write(String(chunk)))
  child.stderr.on('data', chunk => process.stderr.write(String(chunk)))
  const terminateChild = () => {
    if (!child || child.exitCode !== null) return
    shuttingDown = true
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
      } catch {
        if (child.exitCode === null) {
          try { child.kill() } catch (fallbackError) {
            console.error('Failed to terminate Electron child:', fallbackError)
          }
        }
      }
    } else {
      try { child.kill('SIGTERM') } catch (error) {
        if (child.exitCode === null) console.error('Failed to terminate Electron child:', error)
      }
    }
  }
  const removeProfile = () => {
    const resolvedProfile = path.resolve(temporaryProfile)
    const resolvedTempRoot = path.resolve(tmpdir())
    const safePrefix = `${resolvedTempRoot}${path.sep}`
    if (!resolvedProfile.startsWith(safePrefix) || !path.basename(resolvedProfile).startsWith('rvb-red252-ui-')) {
      console.error(`Refusing to remove unexpected Electron profile path: ${resolvedProfile}`)
      return
    }
    try { rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (error) {
      console.error(`Failed to remove temporary Electron profile ${resolvedProfile}:`, error)
    }
  }
  const cleanup = () => {
    terminateChild()
    removeProfile()
  }
  shutdownChild = terminateChild
  process.once('exit', cleanup)
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', code => {
    if (!shuttingDown) process.exitCode = code ?? 1
  })
} else {
  const { app, BrowserWindow } = await import('electron')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const window = new BrowserWindow({
      show: true,
      width: 1440,
      height: 1000,
      webPreferences: { sandbox: false },
    })
    await window.loadURL(entryUrl)
    window.focus()
  }).catch(error => {
    console.error(error.stack || error)
    app.exit(1)
  })
}

if (process.versions.electron) {
  // The Electron child only hosts the visible page. The parent process below owns
  // the CDP connection so that every user action is an Input event.
} else {
  let socket
  let commandId = 0

  async function listTargets() {
    try {
      return await (await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1500) })).json()
    } catch {
      return []
    }
  }

  async function waitForTarget() {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const target = (await listTargets()).find(item => item.type === 'page' && item.url.includes('/battle.html?mode=training'))
      if (target) return target
      await delay(100)
    }
    throw new Error('Electron battle page did not appear')
  }

  async function connect(target) {
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
  }

  async function command(method, params = {}) {
    const id = ++commandId
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000)
      const onMessage = event => {
        const message = JSON.parse(String(event.data))
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
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
    }
    return result.result?.value
  }

  async function until(expression, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return
      } catch {}
      await delay(100)
    }
    throw new Error(label || expression)
  }

  async function visible(selector) {
    return await evaluate(`(() => {
      return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      })
    })()`)
  }

  async function selectorCenter(selector) {
    const point = await evaluate(`(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(candidate => {
        const rect = candidate.getBoundingClientRect()
        const style = getComputedStyle(candidate)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      if (!element) throw new Error('Missing visible control: ' + ${JSON.stringify(selector)})
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
        throw new Error('Control is not visible: ' + ${JSON.stringify(selector)})
      }
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    return point
  }

  async function inputClick(point) {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 })
    await delay(100)
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
    await delay(100)
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async function clickSelector(selector) {
    const point = await selectorCenter(selector)
    await inputClick(point)
    await delay(100)
  }

  async function clickCell(x, y) {
    const point = await evaluate(`(() => {
      const point = window.BattleRenderer3D.projectCell(${Number(x)}, ${Number(y)})
      if (!point) throw new Error('3D board is not mounted')
      return { x: point.clientX, y: point.clientY }
    })()`)
    await inputClick(point)
    await delay(100)
  }

  async function closeVisible(selector) {
    if (await visible(selector)) await clickSelector(selector)
  }

  async function screenshot(file) {
    const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(file, Buffer.from(image.data, 'base64'))
  }

  async function closeTransientOverlays() {
    await closeVisible('dialog.skill-reading-guide button')
    await closeVisible('#pieceInfoModal .pi-close')
    await closeVisible('#cardDetailModal .cd-close')
    await closeVisible('#battleSettings [data-close-settings]')
    await closeVisible('#rulebook [data-close]')
    await closeVisible('#tileStatusPanel .ts-close')
    if (await evaluate("!!document.querySelector('#trainingTools.is-open')")) {
      await clickSelector('#trainingToolsToggle')
    }
  }

  async function run() {
    mkdirSync(outputDir, { recursive: true })
    rmSync(reportPath, { force: true })
    const startedAt = new Date().toISOString()
    const target = await waitForTarget()
    await connect(target)
    await command('Page.bringToFront')
    await command('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until("document.readyState === 'complete' && typeof initTraining === 'function' && typeof PIECES_BY_ID === 'object' && typeof skillsById === 'object' && PIECES_BY_ID.tails && PIECES_BY_ID['red-rafaam'] && skillsById['tails-twin-flight'] && skillsById['rafaam-curse-amplify']", 'battle resources ready')
    const resourceProof = []
    for (const id of ['tails-twin-flight', 'tails-armor-assembly', 'rafaam-curse-amplify', 'minato-spiral-barrage', 'turalyon-grand-crusade']) {
      const disk = JSON.parse(readFileSync(path.join(root, 'data/skills', id + '.json'), 'utf8'))
      const fields = ['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphHash', 'description']
      const expected = Object.fromEntries(fields.filter(key => disk[key] !== undefined).map(key => [key, disk[key]]))
      const loaded = await evaluate(`(() => { const skill = skillsById[${JSON.stringify(id)}]; return Object.fromEntries(${JSON.stringify(fields)}.filter(key => skill[key] !== undefined).map(key => [key, skill[key]])); })()`)
      if (JSON.stringify(expected) !== JSON.stringify(loaded)) throw new Error(`QA resource payload is stale for ${id}; restart scripts/qa/practice-server.mjs`)
      resourceProof.push({ id, sha256: createHash('sha256').update(JSON.stringify(loaded)).digest('hex') })
    }
    const coin = JSON.parse(readFileSync(path.join(root, 'data/cards/lucky-coin.json'), 'utf8'))
    const coinFields = ['code', 'description', 'gameplayModules']
    const expectedCoin = Object.fromEntries(coinFields.map(key => [key, coin[key]]))
    const loadedCoin = await evaluate(`Object.fromEntries(${JSON.stringify(coinFields)}.map(key => [key, cardsById['lucky-coin'][key]]))`)
    if (JSON.stringify(expectedCoin) !== JSON.stringify(loadedCoin)) throw new Error('QA lucky-coin module payload is stale; restart the QA server')
    resourceProof.push({ id: 'cards/lucky-coin', sha256: createHash('sha256').update(JSON.stringify(loadedCoin)).digest('hex') })

    // Establish the roster through the page's own training initializer. The
    // setup sheet is intentionally bypassed as a deterministic QA fixture;
    // all gameplay controls below still use physical CDP Input events.
    await until("!!document.querySelector('#trainingSetupOverlay.show')", 'training setup overlay')
    await closeTransientOverlays()
    const setup = { firstPlayerId: 'training-red', firstFaction: 'blue', secondFaction: 'red', firstTemplateIds: ['tails', 'blue-naruto'], secondTemplateIds: ['red-rafaam'] }
    const started = await evaluate(`(async () => {
      const setup = ${JSON.stringify(setup)}
      trainingSetupConfig = setup
      document.getElementById('trainingSetupOverlay')?.classList.remove('show')
      await initTraining(undefined, setup)
      return { phase: G?.turn?.phase || null, pieces: (G?.pieces || []).map(piece => piece.templateId) }
    })()`)
    if (started.phase !== 'action') throw new Error(`controlled training initializer did not enter action phase: ${JSON.stringify(started)}`)

    const fixed = await evaluate("(() => { const seed = 0x252; G.extensions = G.extensions || {}; G.extensions.debugBattle = { actionLog: [{ rootSeed: seed }], commandLog: [], appliedActionIds: [] }; gameSeed = seed; const tails = G.pieces.find(piece => piece.templateId === 'tails'); const ally = G.pieces.find(piece => piece.templateId === 'blue-naruto'); const enemy = G.pieces.find(piece => piece.templateId === 'red-rafaam'); if (!tails || !ally || !enemy) throw new Error('fixed roster unavailable: ' + JSON.stringify({ setupConfig: trainingSetupConfig, pieces: G.pieces.map(piece => ({ templateId: piece.templateId, pieceId: piece.pieceId, instanceId: piece.instanceId, ownerPlayerId: piece.ownerPlayerId })) })); Object.assign(tails, { x: 5, y: 5, currentHp: 10 }); Object.assign(ally, { x: 6, y: 5, currentHp: 12 }); Object.assign(enemy, { x: 12, y: 12, currentHp: 15 }); G.turn.currentPlayerId = 'training-red'; G.turn.phase = 'action'; G.turn.turnNumber = 1; G.players.forEach(player => { player.actionPoints = player.playerId === 'training-red' ? 10 : 0; player.maxActionPoints = player.playerId === 'training-red' ? 10 : 0; }); myPlayerId = 'training-red'; myFaction = 'blue'; selectedPieceId = null; clearTargetInteraction('fixed-seed'); render(); return { seed: GameEngine.getBattleRootSeed(G), phase: G.turn.phase, pieces: G.pieces.map(piece => ({ id: piece.instanceId, templateId: piece.templateId, x: piece.x, y: piece.y })), graph: !!skillsById['tails-twin-flight']?.contentGraph }; })()")
    await closeTransientOverlays()

    await delay(500)
    const selected = await evaluate(`(() => {
      const piece = G.pieces.find(candidate => candidate.templateId === 'tails')
      const point = window.BattleRenderer3D.projectCell(piece.x, piece.y)
      if (!point || point.clientX < 0 || point.clientY < 0 || point.clientX >= innerWidth || point.clientY >= innerHeight) throw new Error('Tails is outside the visible 3D viewport')
      return { pieceId: piece.instanceId, point: { x: point.clientX, y: point.clientY }, hit: window.BattleRenderer3D.screenToCell(point.clientX, point.clientY) }
    })()`)
    await inputClick(selected.point)
    try {
      await until("!!selectedPieceId && !!document.querySelector('[data-skill-id=\"tails-twin-flight\"]')", 'Tails skill menu')
    } catch (error) {
      const state = await evaluate(`(() => { const point = ${JSON.stringify(selected.point)}; const top = document.elementFromPoint(point.x, point.y); return { point, hit: window.BattleRenderer3D.screenToCell(point.x, point.y), pieces: G.pieces.map(p => ({x:p.x,y:p.y,hp:p.currentHp})), selectedPieceId, menu: document.getElementById('pieceContextMenu')?.outerHTML.slice(0, 300) || '', status: document.getElementById('statusMsg')?.textContent || '', topAtPiece: top ? { id: top.id, className: top.className, tag: top.tagName } : null, modal: document.getElementById('pieceInfoModal')?.style.display || '', targetOverlay: document.getElementById('targetOverlay')?.className || '' }; })()`)
      throw new Error(`${error.message}; state=${JSON.stringify(state)}`)
    }
    await closeVisible('dialog.skill-reading-guide button')
    await clickSelector('[data-skill-id="tails-twin-flight"]')
    await until("pendingSkill && pendingSkill.preparation", 'Tails target prompt')
    const armed = await evaluate("({ pending: !!pendingSkill, overlay: document.getElementById('targetOverlay')?.className || '', prompt: document.getElementById('targetPromptText')?.textContent || '', targetType: pendingSkill?.preparation?.targetType || null, candidates: pendingSkill?.preparation?.candidates || [] })")
    if (armed.overlay !== 'show') throw new Error('Target overlay is not visible')
    await screenshot(screenshotTarget)

    const invalid = await evaluate("(() => { if (!pendingSkill) throw new Error('target draft disappeared before invalid target'); return { before: true }; })()")
    await clickCell(12, 12)
    invalid.after = await evaluate("({ pending: !!pendingSkill, status: document.getElementById('statusMsg')?.textContent || '' })")
    if (!invalid.after.pending || !invalid.after.status.includes('目标')) throw new Error('Invalid target did not preserve pending target mode: ' + JSON.stringify(invalid))

    await clickSelector('[data-skill-id="tails-twin-flight"]')
    const cancelled = await evaluate("({ pending: !!pendingSkill, status: document.getElementById('statusMsg')?.textContent || '', overlay: document.getElementById('targetOverlay')?.className || '' })")
    if (cancelled.pending || cancelled.overlay.includes('show')) throw new Error('Target cancellation did not close target mode')

    // Re-open the same skill through the visible piece card after cancellation.
    if (!(await visible('[data-skill-id="tails-twin-flight"]'))) await inputClick(selected.point)
    if (!(await visible('[data-skill-id="tails-twin-flight"]'))) await inputClick(selected.point)
    await until("!!selectedPieceId && !!document.querySelector('[data-skill-id=\"tails-twin-flight\"]')", 'Tails skill retry menu')
    await clickSelector('[data-skill-id="tails-twin-flight"]')
    await until("pendingSkill && pendingSkill.preparation", 'Tails retry target prompt')

    const ally = await evaluate("(() => { const ref = (pendingSkill.preparation.candidates || []).find(candidate => candidate.type === 'piece' && candidate.pieceId !== selectedPieceId); const piece = G.pieces.find(candidate => candidate.instanceId === ref?.pieceId); if (!piece) throw new Error('Ally target missing'); return { x: piece.x, y: piece.y, pieceId: piece.instanceId }; })()")
    await clickCell(ally.x, ally.y)
    await until("pendingSkill && pendingSkill.preparation && pendingSkill.preparation.targetType === 'cell'", 'Tails first landing prompt')
    const firstCell = await evaluate("(() => { const candidate = (pendingSkill.preparation.candidates || []).find(ref => ref.type === 'cell'); if (!candidate) throw new Error('First landing target missing'); return { x: candidate.x, y: candidate.y }; })()")
    await clickCell(firstCell.x, firstCell.y)
    await until("pendingSkill && pendingSkill.preparation && pendingSkill.preparation.targetType === 'cell'", 'Tails second landing prompt')
    const secondCell = await evaluate(`(() => { const first = ${JSON.stringify(firstCell)}; const candidate = (pendingSkill.preparation.candidates || []).find(ref => ref.type === 'cell' && Math.abs(ref.x - first.x) + Math.abs(ref.y - first.y) === 1); if (!candidate) throw new Error('Second landing target missing'); return { x: candidate.x, y: candidate.y }; })()`)
    await clickCell(secondCell.x, secondCell.y)
    await delay(250)
    if (await visible('#targetConfirmButton')) {
      const confirmDisabled = await evaluate("!!document.getElementById('targetConfirmButton')?.disabled")
      if (!confirmDisabled) await clickSelector('#targetConfirmButton')
    }
    await until("!pendingSkill && !targetSubmissionPending && Array.isArray(G.extensions?.tileEffects) && G.extensions.tileEffects.length >= 2", 'Tails action settlement')
    await delay(1200)
    await closeTransientOverlays()

    const skillAfter = await evaluate(`({ seed: GameEngine.getBattleRootSeed(G), actions: (G.actions || []).slice(-4), tileEffects: (G.extensions || {}).tileEffects || [], tails: G.pieces.find(piece => piece.templateId === 'tails')?.statusTags || [], ally: G.pieces.find(piece => piece.templateId === 'blue-naruto')?.statusTags || [], logs: Array.from(document.querySelectorAll('#logBody p')).map(element => element.textContent), presentationEvents: Array.isArray(latestBattlePresentationEvents) ? latestBattlePresentationEvents.length : 0, presentationChains: Array.isArray(trainingBattlePresentationChains) ? trainingBattlePresentationChains.length : 0, visibleModals: { guide: !!document.querySelector('dialog.skill-reading-guide'), piece: !!document.querySelector('#pieceInfoModal[style*="display: flex"]'), setup: !!document.querySelector('#trainingSetupOverlay.show') } })`)

    // Training starts with an empty hand. Add one ordinary, existing card to
    // the controlled local fixture, then use its rendered hand button twice.
    await evaluate("(() => { const player = G.players.find(candidate => candidate.playerId === 'training-red'); if (!player) throw new Error('training player missing'); player.hand = [{ cardId: 'lucky-coin', instanceId: 'qa-lucky-coin', ownerPlayerId: 'training-red' }]; render(); return player.hand.map(card => ({ cardId: card.cardId, instanceId: card.instanceId })); })()")
    await until("!!document.querySelector('[data-instance-id=\"qa-lucky-coin\"]')", 'ordinary card rendered in hand')
    await clickSelector('[data-instance-id="qa-lucky-coin"]')
    await until("pendingCardAction && pendingCardAction.cardInstanceId === 'qa-lucky-coin'", 'ordinary card preview')
    await clickSelector('[data-instance-id="qa-lucky-coin"]')
    await until("!G.players.find(player => player.playerId === 'training-red')?.hand?.some(card => card.instanceId === 'qa-lucky-coin') && (G.players.find(player => player.playerId === 'training-red')?.actionPoints || 0) >= 9", 'ordinary card settlement')
    await delay(800)
    await closeTransientOverlays()
    await screenshot(screenshotAnimation)
    await until("!document.querySelector('.battle-vignette-layer:not([hidden])')", 'card animation completed', 15000)
    await screenshot(screenshotSettlement)

    const cardAfter = await evaluate(`({ actionPoints: G.players.find(player => player.playerId === 'training-red')?.actionPoints || 0, hand: G.players.find(player => player.playerId === 'training-red')?.hand || [], logs: Array.from(document.querySelectorAll('#logBody p')).map(element => element.textContent), actions: (G.actions || []).slice(-5), visibleModals: { guide: !!document.querySelector('dialog.skill-reading-guide'), piece: !!document.querySelector('#pieceInfoModal[style*="display: flex"]'), setup: !!document.querySelector('#trainingSetupOverlay.show'), settings: !!document.querySelector('#battleSettings[open]') } })`)
    const graphs = await evaluate("(() => { const amplify = skillsById?.['rafaam-curse-amplify']; const armor = skillsById?.['tails-armor-assembly']; const armorGraph = armor?.contentGraph; return { amplify: !!amplify?.contentGraph, armor: !!armorGraph, armorSurface: armorGraph?.surface || null, armorHasMaterializeSource: Array.isArray(armorGraph?.nodes) && armorGraph.nodes.some(node => node?.kind === 'materializeSource'), graphVersion: amplify?.contentGraph?.version || null }; })()")
    if (cardAfter.visibleModals.guide || cardAfter.visibleModals.piece || cardAfter.visibleModals.setup || cardAfter.visibleModals.settings) throw new Error('Settlement screenshot still has a blocking modal')
    if (!cardAfter.logs.some(message => String(message).includes('幸运币'))) throw new Error('Ordinary card log is missing')

    const report = {
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      entry: entryUrl,
      seed: fixed.seed,
      setup: { mode: 'controlled-initTraining-fixture', ...setup },
      graph: graphs,
      resourceProof,
      screenshots: { target: screenshotTarget, animation: screenshotAnimation, settlement: screenshotSettlement },
      interactions: { fixed, selected, armed, invalid, cancelled, ally, firstCell, secondCell, skillAfter, cardAfter },
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log('CONTENT_GRAPH_CANDIDATE_SMOKE', JSON.stringify({ ok: report.ok, target: screenshotTarget, settlement: screenshotSettlement, report: reportPath }))
  }

  run().catch(async error => {
    console.error(error.stack || error)
    if (socket?.readyState === WebSocket.OPEN) {
      try { await screenshot(path.join(outputDir, 'red252-candidate-ui-failure.png')) }
      catch (captureError) { console.error('Could not capture failure state:', captureError) }
    }
    process.exitCode = 1
  }).finally(() => {
    try { socket?.close() } catch {}
    shutdownChild()
    process.exitCode ||= 0
  })
}
