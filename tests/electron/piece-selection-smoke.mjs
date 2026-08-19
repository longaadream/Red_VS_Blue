import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const debugPort = Number(process.env.RVB_RED54_DEBUG_PORT || 19254)
const mainEntry = path.join(root, 'electron-client', 'dist', 'main.js')
const generatedSelectionPage = path.join(root, 'android-client', 'www', 'piece-selection.html')
const standaloneServer = path.join(root, '.next', 'standalone', 'server.js')
const electronCandidates = [
  process.env.RVB_ELECTRON_EXE && path.resolve(process.env.RVB_ELECTRON_EXE),
  path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.resolve(root, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe'),
].filter(Boolean)
const electronExecutable = electronCandidates.find(candidate => fs.existsSync(candidate))
let userDataDirectory = null

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function getJson(url, timeoutMs = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

async function waitForTarget(predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let observed = []
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json`)
      observed = targets.map(({ title, type, url }) => ({ title, type, url }))
      const target = targets.find(predicate)
      if (target) return target
    } catch {}
    await delay(200)
  }
  throw new Error(`No matching Electron target appeared: ${JSON.stringify(observed)}`)
}

async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const sendCommand = async (method, params, timeoutMs, label) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage)
        reject(new Error(`CDP command timed out: ${label}`))
      }, timeoutMs)
      const onMessage = event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== id) return
        clearTimeout(timer)
        socket.removeEventListener('message', onMessage)
        resolve(message)
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  return {
    async command(method, params = {}, timeoutMs = 5000) {
      const response = await sendCommand(method, params, timeoutMs, method)
      if (response.error) throw new Error(JSON.stringify(response.error))
      return response.result
    },
    async evaluate(expression, awaitPromise = true, timeoutMs = 30000) {
      const response = await sendCommand(
        'Runtime.evaluate',
        { expression, awaitPromise, returnByValue: true },
        timeoutMs,
        expression.slice(0, 120),
      )
      if (response.error) throw new Error(JSON.stringify(response.error))
      if (response.result?.exceptionDetails) {
        throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
      }
      return response.result?.result?.value
    },
    fireAndForget(expression) {
      socket.send(JSON.stringify({
        id: ++nextId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: false, returnByValue: false },
      }))
    },
    close() { socket.close() },
  }
}

async function evaluate(target, expression, awaitPromise = true, timeoutMs = 30000) {
  const connection = await connectTarget(target)
  try {
    try {
      await connection.command('Page.handleJavaScriptDialog', { accept: true }, 1000)
    } catch {}
    return await connection.evaluate(expression, awaitPromise, timeoutMs)
  } finally {
    connection.close()
  }
}

async function waitForEvaluation(target, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  let currentTarget = target
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json`)
      currentTarget = targets.find(candidate => candidate.id === target.id)
        || targets.find(candidate => candidate.url === currentTarget.url)
        || currentTarget
      const value = await evaluate(currentTarget, expression, true, 2000)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`Electron condition did not become true: ${expression}; ${lastError || 'no value'}`)
}

async function waitForServer(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ping = await getJson(`${baseUrl}/api/ping`)
      if (ping) return ping
    } catch {}
    await delay(200)
  }
  throw new Error(`Electron local server did not become reachable: ${baseUrl}`)
}

async function openSelection(target, roomId, playerId, alignment) {
  const query = new URLSearchParams({ roomId, playerId, playerName: playerId, alignment })
  const navigationConnection = await connectTarget(target)
  await navigationConnection.command('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__red54SmokeAlerts = [];
      window.alert = (message) => { window.__red54SmokeAlerts.push(String(message)); };
    `,
  })
  navigationConnection.fireAndForget(`location.href = 'piece-selection.html?${query.toString()}';`)
  await delay(100)
  navigationConnection.close()
  const selectionTarget = await waitForTarget(candidate => (
    candidate.url.includes('/piece-selection.html?')
    && candidate.url.includes(`playerId=${playerId}`)
  ))
  await waitForEvaluation(
    selectionTarget,
    `document.readyState === 'complete'
      && typeof loadPieces === 'function'
      && document.querySelectorAll('.piece-card').length >= 8`,
  )
  return selectionTarget
}

async function forceFallback(selectionTarget, expectedFaction) {
  return evaluate(selectionTarget, `(async () => {
    window.fetchPackJson = async (resourcePath) => {
      throw new Error('RED-54 smoke forced local failure: ' + resourcePath)
    }
    const started = performance.now()
    await loadPieces()
    const elapsedMs = performance.now() - started
    const ids = Array.from(document.querySelectorAll('.piece-card'), card => card.dataset.pid)
    const response = await RvBUtils.serverFetch('/api/pieces', { timeoutMs: 2500 })
    const data = await response.json()
    const factionById = Object.fromEntries(data.pieces.map(piece => [piece.id, piece.faction]))
    return {
      elapsedMs,
      ids,
      expectedFaction: ${JSON.stringify(expectedFaction)},
      factions: ids.map(id => factionById[id]),
      message: document.getElementById('pieceGrid').innerText,
      serverUrl: RvBUtils.getServerUrl(),
    }
  })()`)
}

function stopProcessTree(pid) {
  if (!Number.isInteger(pid)) return
  try {
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      timeout: 10000,
      windowsHide: true,
    })
  } catch {}
}

assert(electronExecutable, `Electron executable not found in: ${electronCandidates.join(', ')}`)
assert(fs.existsSync(standaloneServer), `Build Next standalone first; missing ${standaloneServer}`)
assert(fs.existsSync(mainEntry), `Compile Electron client first; missing ${mainEntry}`)
assert(fs.existsSync(generatedSelectionPage), `Sync generated pages first; missing ${generatedSelectionPage}`)
userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red54-smoke-'))

let child = null
let electronLog = ''
try {
  try {
    await getJson(`http://127.0.0.1:${debugPort}/json`, 500)
    throw new Error(`Remote debugging port ${debugPort} is already in use`)
  } catch (error) {
    if (String(error).includes('already in use')) throw error
  }

  child = spawn(electronExecutable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
    mainEntry,
  ], {
    cwd: root,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  assert(Number.isInteger(child.pid), 'Could not determine Electron client PID')
  const captureElectronLog = chunk => {
    electronLog = (electronLog + String(chunk)).slice(-6000)
  }
  child.stdout?.on('data', captureElectronLog)
  child.stderr?.on('data', captureElectronLog)

  const connectPageTarget = await waitForTarget(candidate => (
    candidate.type === 'page'
    && candidate.url.includes('/electron-client/connect/index.html')
  ))
  const rendererBoundary = await evaluate(connectPageTarget, `({
    processType: typeof process,
    requireType: typeof require,
    title: document.title,
  })`)
  assert(rendererBoundary.processType === 'undefined', 'Electron renderer exposes process')
  assert(rendererBoundary.requireType === 'undefined', 'Electron renderer exposes require')

  const connectPageConnection = await connectTarget(connectPageTarget)
  connectPageConnection.fireAndForget('window.electronAPI.openLocalGame()')
  await delay(100)
  connectPageConnection.close()
  let gameTarget
  try {
    gameTarget = await waitForTarget(candidate => candidate.url.startsWith('rvb-client://app/index.html'), 90000)
  } catch (error) {
    throw new Error(
      `Electron local game page did not appear: ${error instanceof Error ? error.message : String(error)}\n`
      + `Electron log:\n${electronLog || '(no output)'}`,
    )
  }
  const mode = await waitForEvaluation(gameTarget, `(async () => {
    if (typeof window.electronAPI?.getMode !== 'function') return null
    const value = await window.electronAPI.getMode()
    return value?.ready && value?.localUrl ? value : null
  })()`, 90000)
  await waitForServer(mode.localUrl, 30000)
  await waitForEvaluation(gameTarget, `typeof window.RvBUtils?.saveServerConfig === 'function'`)
  const connectedServer = await evaluate(gameTarget, `(() => {
    RvBUtils.saveServerConfig({
      mode: 'local',
      url: ${JSON.stringify(mode.localUrl)}
    })
    return RvBUtils.getServerUrl()
  })()`)
  assert(connectedServer === mode.localUrl, `Could not establish current Electron server: ${connectedServer}`)

  const roomId = `red54-smoke-${Date.now().toString(36)}`
  const lightTarget = await openSelection(gameTarget, roomId, 'alice-red54', 'light')
  const lightFallback = await forceFallback(lightTarget, 'good')
  assert(lightFallback.elapsedMs < 5000, `Light fallback exceeded five seconds: ${JSON.stringify(lightFallback)}`)
  assert(lightFallback.ids.length >= 8, `Light fallback did not show enough pieces: ${JSON.stringify(lightFallback)}`)
  assert(lightFallback.factions.every(faction => faction === 'good'), `Light fallback mixed factions: ${JSON.stringify(lightFallback)}`)
  const lightAlignmentLock = await evaluate(lightTarget, `(async () => {
    const before = PIECE_TEMPLATES.map(piece => piece.id)
    await setAlignment('dark')
    return {
      before,
      after: PIECE_TEMPLATES.map(piece => piece.id),
      lightDisabled: document.getElementById('alignmentLightBtn').disabled,
      darkDisabled: document.getElementById('alignmentDarkBtn').disabled,
      notice: document.getElementById('alignmentLockNotice').textContent,
      alerts: window.__red54SmokeAlerts,
    }
  })()`)
  assert(lightAlignmentLock.lightDisabled && lightAlignmentLock.darkDisabled, `Light alignment controls were not locked: ${JSON.stringify(lightAlignmentLock)}`)
  assert(JSON.stringify(lightAlignmentLock.after) === JSON.stringify(lightAlignmentLock.before), `Light player switched alignment locally: ${JSON.stringify(lightAlignmentLock)}`)

  const firstSelection = await evaluate(lightTarget, `(async () => {
    Array.from(document.querySelectorAll('.piece-card'), card => card.dataset.pid)
      .slice(0, 8)
      .forEach(id => togglePiece(id))
    await confirmSelection()
    return {
      selected: document.getElementById('selectedCount').textContent,
      waiting: document.getElementById('waitOverlay').classList.contains('show'),
    }
  })()`)
  assert(firstSelection.selected.includes('8 / 8'), `First player did not select eight pieces: ${JSON.stringify(firstSelection)}`)
  assert(firstSelection.waiting, `First player did not enter waiting state: ${JSON.stringify(firstSelection)}`)

  const darkTarget = await openSelection(lightTarget, roomId, 'bob-red54', 'dark')
  const darkFallback = await forceFallback(darkTarget, 'evil')
  assert(darkFallback.elapsedMs < 5000, `Dark fallback exceeded five seconds: ${JSON.stringify(darkFallback)}`)
  assert(darkFallback.ids.length >= 8, `Dark fallback did not show enough pieces: ${JSON.stringify(darkFallback)}`)
  assert(darkFallback.factions.every(faction => faction === 'evil'), `Dark fallback mixed factions: ${JSON.stringify(darkFallback)}`)
  const darkAlignmentLock = await evaluate(darkTarget, `({
    lightDisabled: document.getElementById('alignmentLightBtn').disabled,
    darkDisabled: document.getElementById('alignmentDarkBtn').disabled,
    notice: document.getElementById('alignmentLockNotice').textContent,
  })`)
  assert(darkAlignmentLock.lightDisabled && darkAlignmentLock.darkDisabled, `Dark alignment controls were not locked: ${JSON.stringify(darkAlignmentLock)}`)

  const connection = await connectTarget(darkTarget)
  connection.fireAndForget(`
    Array.from(document.querySelectorAll('.piece-card'), card => card.dataset.pid)
      .slice(0, 8)
      .forEach(id => togglePiece(id));
    confirmSelection();
  `)
  await delay(100)
  connection.close()

  const battleTarget = await waitForTarget(candidate => (
    candidate.url.includes('/battle.html?') && candidate.url.includes(`roomId=${roomId}`)
  ), 30000)
  const battle = await waitForEvaluation(battleTarget, `({
    roomId: new URLSearchParams(location.search).get('roomId'),
    title: document.title,
    url: location.href,
  })`)
  assert(battle.roomId === roomId, `Shared battle page has wrong room: ${JSON.stringify(battle)}`)

  console.log(JSON.stringify({
    entry: 'RED-54 Electron development selection smoke',
    rendererBoundary,
    localServer: mode.localUrl,
    lightFallback,
    lightAlignmentLock,
    firstSelection,
    darkFallback,
    darkAlignmentLock,
    battle,
  }))
} finally {
  stopProcessTree(child?.pid)
  await delay(1000)
  try {
    fs.rmSync(userDataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    })
  } catch (error) {
    console.warn(`[RED-54 smoke] Could not remove temporary userData ${userDataDirectory}:`, error)
  }
}
