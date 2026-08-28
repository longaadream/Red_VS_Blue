import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    launchArguments: process.env.RVB_SMOKE_USER_DATA_DIR
      ? [`--user-data-dir=${path.resolve(process.env.RVB_SMOKE_USER_DATA_DIR)}`]
      : [],
    title: '连接服务器',
    debugPort: 19222,
  },
  editor: {
    executable: process.env.RVB_SMOKE_EDITOR_EXE
      ? path.resolve(process.env.RVB_SMOKE_EDITOR_EXE)
      : path.join(root, 'dist', 'editor', 'RED vs BLUE Editor 0.1.0.exe'),
    launchArguments: process.env.RVB_SMOKE_USER_DATA_DIR
      ? [`--user-data-dir=${path.resolve(process.env.RVB_SMOKE_USER_DATA_DIR)}`]
      : [],
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

async function verifyBattleTerminalError(port, target, timeoutMs = 5000) {
  await evaluate(target, "window.location.href = 'rvb-client://app/battle.html'; true", false)
  const battleTarget = await waitForTargets(
    port,
    (candidate) => candidate.url.startsWith('rvb-client://app/battle.html'),
    timeoutMs,
  )
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    try {
      observed = await evaluate(battleTarget, `({
        readyState: document.readyState,
        message: document.getElementById('loadingMsg')?.textContent || '',
        messageColor: document.getElementById('loadingMsg')?.style.color || '',
        spinnerDisplay: document.querySelector('#loadingOverlay .spinner')?.style.display || '',
      })`)
      if (observed.message.includes('缺少 roomId 或 playerId')) {
        return { target: battleTarget, runtime: observed }
      }
    } catch {}
    await delay(100)
  }
  throw new Error(`Battle page did not expose its terminal setup error: ${JSON.stringify(observed)}`)
}

function stopCandidates(executable) {
  const escaped = executable.replaceAll("'", "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 5000 })
  } catch {}
}

function countExecutableProcesses(executable) {
  const escaped = executable.replaceAll("'", "''")
  const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' }).Count`
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim()
    const count = Number(output)
    return Number.isInteger(count) ? count : null
  } catch {
    return null
  }
}

async function waitForExecutableCleanup(executables, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let counts = Object.fromEntries(executables.map((executable) => [executable, null]))
  while (Date.now() < deadline) {
    counts = Object.fromEntries(
      executables.map((executable) => [executable, countExecutableProcesses(executable)]),
    )
    if (Object.values(counts).every((count) => count === 0)) return counts
    await delay(250)
  }
  return counts
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

async function probeGameWebSocket(url) {
  const requestId = 'windows-smoke-rooms-' + process.pid + '-' + Date.now()
  const socket = new WebSocket(url)
  return new Promise((resolve, reject) => {
    let subscribed = null
    let roomsResult = null
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Game WebSocket probe timed out: ' + url))
    }, 5000)
    const finish = () => {
      if (!subscribed || !roomsResult) return
      clearTimeout(timer)
      socket.close()
      resolve({
        url,
        subscribed: {
          roomId: subscribed.roomId,
          role: subscribed.role,
        },
        roomsResult: {
          ok: roomsResult.ok,
          rooms: roomsResult.data?.rooms,
        },
      })
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        roomId: '__lobby',
        playerId: 'red53-windows-smoke',
      }))
      socket.send(JSON.stringify({
        type: 'rpc',
        requestId,
        method: 'rooms.list',
        data: {},
      }))
    }, { once: true })
    socket.addEventListener('message', (event) => {
      let message = null
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message?.type === 'subscribed' && message.roomId === '__lobby') {
        subscribed = message
      }
      if (message?.type === 'rpcResult' && message.requestId === requestId) {
        roomsResult = message
      }
      finish()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Game WebSocket connection failed: ' + url))
    }, { once: true })
    socket.addEventListener('close', () => {
      if (subscribed && roomsResult) return
      clearTimeout(timer)
      reject(new Error('Game WebSocket closed before the probe completed: ' + url))
    }, { once: true })
  })
}

async function verifyPieceGallery(port, target, timeoutMs = 10000) {
  await evaluate(target, "window.location.href = 'rvb-client://app/pieces.html'; true", false)
  const galleryTarget = await waitForTargets(
    port,
    (candidate) => candidate.url.startsWith('rvb-client://app/pieces.html'),
    timeoutMs,
  )
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    try {
      observed = await evaluate(galleryTarget, `({
        readyState: document.readyState,
        allCount: document.querySelectorAll('.piece-card').length,
        countLabel: document.getElementById('countLabel')?.textContent || '',
      })`)
      if (observed.readyState === 'complete' && observed.allCount > 0) break
    } catch {}
    await delay(100)
  }
  assert(observed?.allCount > 0, `Piece gallery did not load packaged pieces: ${JSON.stringify(observed)}`)

  const light = await evaluate(galleryTarget, `(() => {
    document.getElementById('btnLight').click()
    return {
      count: document.querySelectorAll('.piece-card').length,
      labels: [...document.querySelectorAll('.piece-meta')].map((element) => element.textContent || ''),
    }
  })()`)
  const dark = await evaluate(galleryTarget, `(() => {
    document.getElementById('btnDark').click()
    return {
      count: document.querySelectorAll('.piece-card').length,
      labels: [...document.querySelectorAll('.piece-meta')].map((element) => element.textContent || ''),
    }
  })()`)
  assert(
    light.count > 0 && light.labels.every((label) => label.includes('光方') && !label.includes('中立')),
    `Piece gallery light filter is incorrect: ${JSON.stringify(light)}`,
  )
  assert(
    dark.count > 0 && dark.labels.every((label) => label.includes('暗方') && !label.includes('中立')),
    `Piece gallery dark filter is incorrect: ${JSON.stringify(dark)}`,
  )
  return { target: galleryTarget, all: observed, light, dark }
}

async function callGameRpc(url, method, data) {
  const requestId = 'windows-smoke-rpc-' + process.pid + '-' + Date.now()
  const socket = new WebSocket(url)
  return new Promise((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Game WebSocket RPC timed out: ${method} ${url}`))
    }, 5000)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'rpc', requestId, method, data }))
    }, { once: true })
    socket.addEventListener('message', (event) => {
      let message = null
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message?.type !== 'rpcResult' || message.requestId !== requestId) return
      finished = true
      clearTimeout(timer)
      socket.close()
      resolve({ ok: message.ok, data: message.data, error: message.error })
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`Game WebSocket RPC connection failed: ${url}`))
    }, { once: true })
    socket.addEventListener('close', () => {
      if (finished) return
      clearTimeout(timer)
      reject(new Error(`Game WebSocket closed before ${method} completed: ${url}`))
    }, { once: true })
  })
}

async function waitForUnreachable(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isReachable(port))) return true
    await delay(250)
  }
  return false
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
  const child = spawn(application.executable, [
    `--remote-debugging-port=${application.debugPort}`,
    ...(application.launchArguments ?? []),
  ], {
    detached: true,
    stdio: process.env.RVB_SMOKE_CHILD_STDIO === 'inherit' ? 'inherit' : 'ignore',
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
  let result = null
  try {
    const { target, rendererBoundary } = await launch(application, 90000)
    let initial = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      initial = await evaluate(target, `window.electronAPI.getStatus()`)
      if (initial.running === true && initial.port === 3000 && await isReachable(3000)) break
      await delay(250)
    }
    assert(initial?.running === true && initial.port === 3000 && await isReachable(3000), `Server did not become ready on port 3000: ${JSON.stringify(initial)}`)
    const ping = await getJson('http://127.0.0.1:3000/api/ping')
    const rooms = await getJson('http://127.0.0.1:3000/api/rooms')
    const publicWebSocket = await probeGameWebSocket(
      'ws://127.0.0.1:3000/ws/rooms/__lobby',
    )
    assert(
      publicWebSocket.roomsResult.ok === true &&
        Array.isArray(publicWebSocket.roomsResult.rooms),
      'Public same-port WebSocket rooms.list failed: ' + JSON.stringify(publicWebSocket),
    )
    const rejectedNavigation = await evaluate(target, `new Promise((resolve) => {
      const original = location.href
      location.href = 'https://example.com/red19-navigation-probe'
      setTimeout(() => resolve({ original, current: location.href }), 500)
    })`)
    assert(rejectedNavigation.current === rejectedNavigation.original, `Server renderer escaped its trusted file root: ${JSON.stringify(rejectedNavigation)}`)
    await evaluate(target, `window.electronAPI.stopServer()`)
    let stopped = false
    let helperProcessCounts = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = await evaluate(target, `window.electronAPI.getStatus()`)
      helperProcessCounts = Object.fromEntries(
        (application.helperExecutables ?? []).map((executable) => [
          executable,
          countExecutableProcesses(executable),
        ]),
      )
      if (
        !status.running &&
        !(await isReachable(3000)) &&
        Object.values(helperProcessCounts).every((count) => count === 0)
      ) {
        stopped = true
        break
      }
      await delay(250)
    }
    assert(
      stopped,
      `Server stop did not release port 3000 and its helper process: ${JSON.stringify(helperProcessCounts)}`,
    )
    result = {
      entry: 'server',
      rendererBoundary,
      http: {
        ping,
        rooms,
      },
      publicWebSocket,
      internalWebSocket,
      rejectedNavigation,
      stopped: true,
      port3000Reachable: false,
      helperProcessCountsAfterStop: helperProcessCounts,
    }
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
  }

  const candidateExecutables = [application.executable, ...(application.helperExecutables ?? [])]
  const processCountsAfterExit = await waitForExecutableCleanup(candidateExecutables)
  assert(
    Object.values(processCountsAfterExit).every((count) => count === 0),
    `Server candidate left residual processes: ${JSON.stringify(processCountsAfterExit)}`,
  )
  assert(!(await isReachable(3000)), 'Server candidate left port 3000 reachable after exit')
  assert(await waitForDebuggerExit(application.debugPort), 'Server Electron process remained reachable after exit')
  console.log(JSON.stringify({ ...result, exitedCleanly: true, processCountsAfterExit }))
}

async function smokeClient() {
  const application = applications.client
  const configuredUserDataDir = process.env.RVB_SMOKE_USER_DATA_DIR
  const userDataDir = configuredUserDataDir
    ? path.resolve(configuredUserDataDir)
    : mkdtempSync(path.join(tmpdir(), 'rvb-client-windows-smoke-'))
  const ownsUserDataDir = !configuredUserDataDir
  application.launchArguments = [`--user-data-dir=${userDataDir}`]
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
    const homepageWindowBoundary = await evaluate(gameTarget, `new Promise((resolve) => {
      const childWindow = window.open('https://example.com/red55-popup-probe', '_blank')
      setTimeout(() => resolve({
        debugButtonPresent: document.getElementById('debugPvpBtn') !== null,
        debugStatusPresent: document.getElementById('debugPvpStatus') !== null,
        debugFunctionType: typeof window.startLocalPvpDebug,
        childWindowWasDenied: childWindow === null
      }), 500)
    })`)
    assert(
      homepageWindowBoundary.debugButtonPresent === false
        && homepageWindowBoundary.debugStatusPresent === false
        && homepageWindowBoundary.debugFunctionType === 'undefined',
      `Client still exposes the removed local PVP debugger: ${JSON.stringify(homepageWindowBoundary)}`,
    )
    assert(
      homepageWindowBoundary.childWindowWasDenied === true,
      `Client game renderer opened a child window: ${JSON.stringify(homepageWindowBoundary)}`,
    )
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
    const localGatewayPort = mode.localUrl ? Number(new URL(mode.localUrl).port) : 38521
    assert(await isReachable(localGatewayPort), 'Client local gateway is not reachable')
    const localBaseUrl = `http://127.0.0.1:${localGatewayPort}`
    const roomsBeforeCreate = await getJson(`${localBaseUrl}/api/rooms`)
    assert(
      Array.isArray(roomsBeforeCreate.rooms) && roomsBeforeCreate.rooms.length === 0,
      `Fresh client database did not return an empty room list: ${JSON.stringify(roomsBeforeCreate)}`,
    )
    const createdRoom = await callGameRpc(
      `ws://127.0.0.1:${localGatewayPort}/ws/rooms/__lobby`,
      'rooms.create',
      {
        hostId: 'red125-windows-smoke',
        name: 'RED-125 Windows smoke room',
        mapId: 'winding-pass',
        visibility: 'public',
      },
    )
    assert(
      createdRoom.ok === true
        && typeof createdRoom.data?.id === 'string'
        && createdRoom.data?.mapId === 'winding-pass',
      `Fresh client database could not create a room: ${JSON.stringify(createdRoom)}`,
    )
    const roomsAfterCreate = await getJson(`${localBaseUrl}/api/rooms`)
    assert(
      Array.isArray(roomsAfterCreate.rooms)
        && roomsAfterCreate.rooms.some((room) => room.id === createdRoom.data.id),
      `Created room was not persisted in the client database: ${JSON.stringify(roomsAfterCreate)}`,
    )
    const pieceGallery = await verifyPieceGallery(application.debugPort, gameTarget)
    const battle = await verifyBattleTerminalError(application.debugPort, pieceGallery.target)
    assert(battle.runtime.readyState === 'complete', `Battle page did not finish loading: ${JSON.stringify(battle.runtime)}`)
    assert(battle.runtime.messageColor === 'rgb(248, 113, 113)', `Battle page did not style its terminal error: ${JSON.stringify(battle.runtime)}`)
    assert(battle.runtime.spinnerDisplay === 'none', `Battle page kept spinning after a terminal error: ${JSON.stringify(battle.runtime)}`)
    await evaluate(battle.target, 'window.close(); true', false)
    assert(await waitForDebuggerExit(application.debugPort), 'Client left its main Electron process after its last window closed')
    assert(await waitForUnreachable(localGatewayPort), 'Client left its local gateway listening after exit')
    const candidateExecutables = [application.executable, ...(application.helperExecutables ?? [])]
    const processCountsAfterExit = await waitForExecutableCleanup(candidateExecutables)
    assert(
      Object.values(processCountsAfterExit).every((count) => count === 0),
      `Client candidate left residual processes: ${JSON.stringify(processCountsAfterExit)}`,
    )
    console.log(JSON.stringify({
      entry: 'client',
      rendererBoundary,
      invalidTlsCertificate: tlsProbe,
      homepageWindowBoundary,
      packagedAssets,
      localMode: mode,
      databaseProbe: { roomsBeforeCreate, createdRoom, roomsAfterCreate },
      pieceGallery: { all: pieceGallery.all, light: pieceGallery.light, dark: pieceGallery.dark },
      battleRuntime: battle.runtime,
      exitedCleanly: true,
      processCountsAfterExit,
    }))
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    if (ownsUserDataDir) rmSync(userDataDir, { recursive: true, force: true })
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
