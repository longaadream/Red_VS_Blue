import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const electronEntry = path.join(root, 'electron-client', 'dist', 'main.js')
const standaloneEntry = path.join(root, '.next', 'standalone', 'server.js')
const debugPort = 19471
const screenshotPath = path.join(os.tmpdir(), 'red-47-electron-training-smoke.png')
const logs = []

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

async function listTargets() {
  try {
    return await getJson(`http://127.0.0.1:${debugPort}/json`)
  } catch {
    return []
  }
}

async function waitForTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let observed = []
  while (Date.now() < deadline) {
    const targets = await listTargets()
    observed = targets.map(({ title, type, url }) => ({ title, type, url }))
    const target = targets.find(predicate)
    if (target) return target
    await delay(100)
  }
  throw new Error(`${label} did not appear: ${JSON.stringify(observed)}`)
}

async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  async function command(method, params = {}, timeoutMs = 10000) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      const onMessage = (event) => {
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

  return {
    async evaluate(expression, timeoutMs = 10000) {
      const response = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, timeoutMs)
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || 'Renderer evaluation failed')
      }
      return response.result?.value
    },
    evaluateFireAndForget(expression) {
      socket.send(JSON.stringify({
        id: ++nextId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: false, returnByValue: false },
      }))
    },
    command,
    close() {
      socket.close()
    },
  }
}

async function evaluate(target, expression, timeoutMs = 10000) {
  const connection = await connectTarget(target)
  try {
    return await connection.evaluate(expression, timeoutMs)
  } finally {
    connection.close()
  }
}

async function waitForExpression(targetProvider, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const target = await targetProvider()
      if (target && await evaluate(target, expression)) return target
    } catch {}
    await delay(100)
  }
  throw new Error(`${label} did not become ready`)
}

function stopProcessTree(processId) {
  if (!Number.isInteger(processId)) return
  try {
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(processId)], {
      stdio: 'ignore',
      timeout: 10000,
    })
  } catch {}
}

async function removeSmokeUserData() {
  const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`
  const resolvedUserData = path.resolve(userDataDirectory)
  if (
    resolvedUserData.startsWith(resolvedTemp)
    && path.basename(resolvedUserData).startsWith('rvb-red47-training-smoke-')
  ) {
    let lastError = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(resolvedUserData, { recursive: true, force: true })
        return
      } catch (error) {
        if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
        lastError = error
        await delay(250)
      }
    }
    throw lastError
  }
}

for (const requiredPath of [electronExecutable, electronEntry, standaloneEntry]) {
  assert(existsSync(requiredPath), `Missing prerequisite: ${requiredPath}`)
}

const userDataDirectory = mkdtempSync(path.join(os.tmpdir(), 'rvb-red47-training-smoke-'))
let electronProcess = null
try {
  electronProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
    electronEntry,
  ], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  electronProcess.stdout.on('data', (chunk) => logs.push(String(chunk)))
  electronProcess.stderr.on('data', (chunk) => logs.push(String(chunk)))

  let connectWindowTarget = await waitForTarget(
    (target) => target.type === 'page' && target.url.includes('/electron-client/connect/index.html'),
    90000,
    'Electron connect window',
  )
  connectWindowTarget = await waitForExpression(
    async () => (await listTargets()).find((target) => target.url.includes('/electron-client/connect/index.html')),
    `document.readyState === 'complete' && typeof window.electronAPI?.openLocalGame === 'function'`,
    10000,
    'Connect preload bridge',
  )
  const connectConnection = await connectTarget(connectWindowTarget)
  connectConnection.evaluateFireAndForget('window.electronAPI.openLocalGame()')

  let homeTarget = await waitForTarget(
    (target) => target.type === 'page' && target.url.startsWith('rvb-client://app/index.html'),
    30000,
    'Electron game window',
  )
  connectConnection.close()
  homeTarget = await waitForExpression(
    async () => (await listTargets()).find((target) => target.url.startsWith('rvb-client://app/index.html')),
    `document.readyState === 'complete' && typeof window.electronAPI?.getMode === 'function'`,
    10000,
    'Game preload bridge',
  )

  let mode = null
  const modeDeadline = Date.now() + 10000
  while (Date.now() < modeDeadline) {
    mode = await evaluate(homeTarget, 'window.electronAPI.getMode()')
    if (mode?.ready && mode?.isLocal) break
    await delay(100)
  }
  assert(mode?.ready === true && mode?.isLocal === true, `Local mode is not ready: ${JSON.stringify(mode)}`)

  const clickStartedAt = Date.now()
  const clicked = await evaluate(homeTarget, `(() => {
    const entry = document.querySelector('[onclick="goToTraining()"]')
    if (!entry) return false
    entry.click()
    return true
  })()`)
  assert(clicked, 'Training entry was not found on the home page')

  let battleTarget = await waitForTarget(
    (target) => target.type === 'page' && target.url.includes('/battle.html?mode=training'),
    5000,
    'Canonical training route',
  )
  let setup = null
  const setupDeadline = clickStartedAt + 5000
  while (Date.now() < setupDeadline) {
    try {
      battleTarget = (await listTargets()).find((target) => target.url.includes('/battle.html?mode=training'))
      if (!battleTarget) continue
      setup = await evaluate(battleTarget, `({
        url: location.href,
        setupVisible: document.getElementById('trainingSetupOverlay')?.classList.contains('show') === true,
        loadingText: document.getElementById('loadingMsg')?.textContent || '',
        pieceTemplates: typeof PIECES_BY_ID === 'object' ? Object.keys(PIECES_BY_ID).length : -1,
        skillTemplates: typeof skillsById === 'object' ? Object.keys(skillsById).length : -1,
        setupOptions: document.querySelectorAll('.training-piece-option input').length
      })`)
      if (setup.setupVisible) break
    } catch {}
    await delay(100)
  }
  const setupElapsedMs = Date.now() - clickStartedAt
  assert(setup?.setupVisible === true, `Training setup was not visible within 5 seconds: ${JSON.stringify(setup)}`)
  assert(
    setup.pieceTemplates > 0 && setup.skillTemplates > 0 && setup.setupOptions > 0,
    `Training assets are missing: ${JSON.stringify(setup)}`,
  )

  const started = await evaluate(battleTarget, `(() => {
    const button = document.querySelector('#trainingSetupOverlay button[onclick="startTrainingFromSetup()"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  assert(started, 'Start training button was not found')

  let battle = null
  const battleDeadline = Date.now() + 15000
  while (Date.now() < battleDeadline) {
    battleTarget = (await listTargets()).find((target) => target.url.includes('/battle.html?mode=training'))
    if (!battleTarget) {
      await delay(100)
      continue
    }
    try {
      battle = await evaluate(battleTarget, `({
        players: Array.isArray(G?.players) ? G.players.length : 0,
        pieces: Array.isArray(G?.pieces) ? G.pieces.length : 0,
        phase: G?.turn?.phase || null,
        canvasCount: document.querySelectorAll('canvas').length,
        setupVisible: document.getElementById('trainingSetupOverlay')?.classList.contains('show') === true,
        loadingDisplay: document.getElementById('loadingOverlay')?.style.display || '',
        loadingText: document.getElementById('loadingMsg')?.textContent || ''
      })`)
      if (
        battle.players === 2
        && battle.pieces >= 2
        && battle.phase === 'action'
        && battle.canvasCount >= 1
        && battle.loadingDisplay === 'none'
      ) break
    } catch {}
    await delay(100)
  }
  assert(
    battle?.players === 2 && battle?.pieces >= 2 && battle?.phase === 'action',
    `Training battle did not start: ${JSON.stringify(battle)}`,
  )
  assert(
    battle.canvasCount >= 1 && battle.loadingDisplay === 'none' && battle.setupVisible === false,
    `Training battle UI is not visible: ${JSON.stringify(battle)}`,
  )

  const placementOptions = await evaluate(battleTarget, `(() => {
    const owner = document.getElementById('placeOwner')
    if (!owner || typeof refreshPlaceTemplates !== 'function') return []
    return G.players.map((player) => {
      owner.value = player.playerId
      refreshPlaceTemplates()
      const templateIds = Array.from(document.querySelectorAll('#placeTemplate option'))
        .map((option) => option.value)
        .filter(Boolean)
      return {
        faction: player.faction,
        templateIds,
        templateFactions: templateIds.map((id) => PIECES_BY_ID[id]?.faction || null),
      }
    })
  })()`)
  assert(
    placementOptions.length === 2 && placementOptions.every((entry) => entry.templateIds.length > 0),
    `Training placement templates are empty: ${JSON.stringify(placementOptions)}`,
  )
  assert(
    placementOptions.every((entry) => {
      const expectedFaction = entry.faction === 'red' ? 'evil' : 'good'
      return entry.templateFactions.every((faction) => faction === expectedFaction || faction === 'neutral' || faction === null)
    }),
    `Training placement templates include the wrong faction: ${JSON.stringify(placementOptions)}`,
  )

  const screenshotConnection = await connectTarget(battleTarget)
  const screenshot = await screenshotConnection.command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  screenshotConnection.close()
  mkdirSync(path.dirname(screenshotPath), { recursive: true })
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

  console.log(JSON.stringify({
    entry: 'electron-dev-training-route',
    mode,
    setupElapsedMs,
    setup,
    battle,
    placementOptions,
    screenshotPath,
  }))
} catch (error) {
  console.error(error.stack || error)
  console.error(logs.join('').slice(-8000))
  process.exitCode = 1
} finally {
  stopProcessTree(electronProcess?.pid)
  await delay(500)
  await removeSmokeUserData()
}
