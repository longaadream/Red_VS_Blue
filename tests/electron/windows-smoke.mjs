import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const applications = {
  server: {
    executable: path.join(root, 'dist', 'server-build', 'win-unpacked', 'RED vs BLUE Server.exe'),
    helperExecutables: [path.join(root, 'dist', 'server-build', 'win-unpacked', 'resources', 'node.exe')],
    title: 'RED vs BLUE Server',
    debugPort: 19221,
  },
  client: {
    executable: path.join(root, 'dist', 'client-build', 'win-unpacked', 'RED vs BLUE.exe'),
    helperExecutables: [path.join(root, 'dist', 'client-build', 'win-unpacked', 'resources', 'node.exe')],
    title: '连接服务器',
    debugPort: 19222,
  },
  editor: {
    executable: path.join(root, 'dist', 'editor', 'RED vs BLUE Editor 0.1.0.exe'),
    title: '数据编辑器',
    debugPort: 19223,
  },
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

async function waitForTargets(port, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let observedTargets = []
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`)
      observedTargets = targets.map(({ title, type, url }) => ({ title, type, url }))
      const match = targets.find(predicate)
      if (match) return match
    } catch {}
    await delay(250)
  }
  throw new Error(`No matching renderer target appeared on debugging port ${port}: ${JSON.stringify(observedTargets)}`)
}

async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  return {
    async evaluate(expression, awaitPromise = true, timeoutMs = 30000) {
      const id = ++nextId
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.removeEventListener('message', onMessage)
          reject(new Error(`CDP evaluation timed out: ${expression.slice(0, 120)}`))
        }, timeoutMs)
        const onMessage = (event) => {
          const message = JSON.parse(String(event.data))
          if (message.id !== id) return
          clearTimeout(timer)
          socket.removeEventListener('message', onMessage)
          resolve(message)
        }
        socket.addEventListener('message', onMessage)
        socket.send(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise, returnByValue: true },
        }))
      })
      if (response.error) throw new Error(JSON.stringify(response.error))
      if (response.result?.exceptionDetails) {
        throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
      }
      return response.result?.result?.value
    },
    evaluateFireAndForget(expression) {
      socket.send(JSON.stringify({
        id: ++nextId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: false, returnByValue: false },
      }))
    },
    close() { socket.close() },
  }
}

async function evaluate(target, expression, awaitPromise = true) {
  const connection = await connectTarget(target)
  try {
    return await connection.evaluate(expression, awaitPromise)
  } finally {
    connection.close()
  }
}

function stopCandidates(executable) {
  const escaped = executable.replaceAll("'", "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 5000 })
  } catch {}
}

function stopProcessTree(pid) {
  if (!Number.isInteger(pid)) return
  try {
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 })
  } catch {}
}

function stopApplication(application) {
  stopProcessTree(application.launchedPid)
  application.launchedPid = null
  for (const executable of [application.executable, ...(application.helperExecutables ?? [])]) {
    stopCandidates(executable)
  }
}

async function isReachable(port) {
  try {
    await getJson(`http://127.0.0.1:${port}/api/ping`)
    return true
  } catch {
    return false
  }
}

async function waitForDebuggerExit(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await getJson(`http://127.0.0.1:${port}/json`)
    } catch {
      return true
    }
    await delay(250)
  }
  return false
}

function stopDebugTarget(port) {
  const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 5000 })
  } catch {}
}

async function launch(application, timeoutMs = 30000) {
  assert(existsSync(application.executable), `Missing executable: ${application.executable}`)
  stopApplication(application)
  stopDebugTarget(application.debugPort)
  const child = spawn(application.executable, [`--remote-debugging-port=${application.debugPort}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  const launchedPid = child.pid
  assert(Number.isInteger(launchedPid), `Could not determine launched process ID for ${application.executable}`)
  application.launchedPid = launchedPid
  const target = await waitForTargets(application.debugPort, (candidate) => candidate.title === application.title, timeoutMs)
  const rendererBoundary = await evaluate(target, `({
    title: document.title,
    processType: typeof process,
    requireType: typeof require,
    url: location.href
  })`)
  assert(rendererBoundary.processType === 'undefined', `${application.title} exposes process to the renderer`)
  assert(rendererBoundary.requireType === 'undefined', `${application.title} exposes require to the renderer`)
  return { target, rendererBoundary }
}

async function smokeServer() {
  const application = applications.server
  try {
    const { target, rendererBoundary } = await launch(application, 90000)
    let initial = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      initial = await evaluate(target, `window.electronAPI.getStatus()`)
      if (initial.running === true && initial.port === 3000 && await isReachable(3000)) break
      await delay(250)
    }
    assert(initial?.running === true && initial.port === 3000 && await isReachable(3000), `Server did not become ready on port 3000: ${JSON.stringify(initial)}`)
    const rejectedNavigation = await evaluate(target, `new Promise((resolve) => {
      const original = location.href
      location.href = 'https://example.com/red19-navigation-probe'
      setTimeout(() => resolve({ original, current: location.href }), 500)
    })`)
    assert(rejectedNavigation.current === rejectedNavigation.original, `Server renderer escaped its trusted file root: ${JSON.stringify(rejectedNavigation)}`)
    await evaluate(target, `window.electronAPI.stopServer()`)
    let stopped = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = await evaluate(target, `window.electronAPI.getStatus()`)
      if (!status.running && !(await isReachable(3000))) {
        stopped = true
        break
      }
      await delay(250)
    }
    assert(stopped, 'Server stop did not release port 3000')
    console.log(JSON.stringify({ entry: 'server', rendererBoundary, rejectedNavigation, stopped: true, port3000Reachable: false }))
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
  }
}

async function smokeClient() {
  const application = applications.client
  try {
    const { target, rendererBoundary } = await launch(application)
    const connection = await connectTarget(target)
    const tlsProbe = await connection.evaluate(`new Promise((resolve) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      fetch('https://self-signed.badssl.com/', { cache: 'no-store', signal: controller.signal })
        .then(() => resolve('accepted'), () => resolve('rejected'))
        .finally(() => clearTimeout(timer))
    })`, true, 20000)
    assert(tlsProbe === 'rejected', `Client unexpectedly accepted an invalid HTTPS certificate: ${tlsProbe}`)
    connection.evaluateFireAndForget(`window.electronAPI.openLocalGame()`)
    const gameTarget = await waitForTargets(application.debugPort, (candidate) => candidate.url.startsWith('rvb-client://app/index.html'))
    connection.close()
    let gameBridgeReady = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        gameBridgeReady = await evaluate(gameTarget, `typeof window.electronAPI?.getMode === 'function'`)
      } catch {}
      if (gameBridgeReady) break
      await delay(250)
    }
    assert(gameBridgeReady, 'Client game preload bridge did not become ready')
    const mode = await evaluate(gameTarget, `window.electronAPI.getMode()`)
    const packagedAssets = await evaluate(gameTarget, `Promise.all([
      'index.html',
      'js/server-utils.js',
      'data/pieces/ana.json',
      'images/terrain/floor.webp'
    ].map(async (relativePath) => {
      const response = await fetch(new URL(relativePath, location.href))
      return [relativePath, response.ok, (await response.arrayBuffer()).byteLength]
    }))`)
    assert(packagedAssets.every(([, ok, size]) => ok && size > 0), `Client packaged assets are incomplete: ${JSON.stringify(packagedAssets)}`)
    assert(mode.ready === true && mode.isLocal === true, `Client local mode is not ready: ${JSON.stringify(mode)}`)
    assert(await isReachable(mode.localUrl ? Number(new URL(mode.localUrl).port) : 38521), 'Client local gateway is not reachable')
    await evaluate(gameTarget, 'window.close(); true', false)
    assert(await waitForDebuggerExit(application.debugPort), 'Client left its main Electron process after its last window closed')
    assert(!(await isReachable(mode.localUrl ? Number(new URL(mode.localUrl).port) : 38521)), 'Client left its local gateway listening after exit')
    console.log(JSON.stringify({ entry: 'client', rendererBoundary, invalidTlsCertificate: tlsProbe, packagedAssets, localMode: mode, exitedCleanly: true }))
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
  }
}

async function smokeEditor() {
  const application = applications.editor
  try {
    const startedAt = Date.now()
    const { target, rendererBoundary } = await launch(application, 300000)
    const startupMilliseconds = Date.now() - startedAt
    const counts = await evaluate(target, `Promise.all(['pieces', 'skills', 'cards', 'rules'].map(async (directory) => [directory, (await window.editorAPI.listFiles(directory)).length]))`)
    assert(counts.every(([, count]) => count > 0), `Editor could not list packaged data files: ${JSON.stringify(counts)}`)
    await evaluate(target, 'window.close(); true', false)
    assert(await waitForDebuggerExit(application.debugPort), 'Editor portable process did not exit after its window closed')
    console.log(JSON.stringify({ entry: 'editor', portableArtifact: application.executable, startupMilliseconds, rendererBoundary, dataFileCounts: Object.fromEntries(counts), exitedCleanly: true }))
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
  }
}

const requested = process.argv.slice(2)
const entries = requested.length > 0 ? requested : ['server', 'client', 'editor']
for (const entry of entries) {
  if (entry === 'server') await smokeServer()
  else if (entry === 'client') await smokeClient()
  else if (entry === 'editor') await smokeEditor()
  else throw new Error(`Unknown entry: ${entry}`)
}

process.exit(0)
