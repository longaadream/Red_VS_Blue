import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client as ColyseusClient } from '@colyseus/sdk'

const root = path.resolve(import.meta.dirname, '..', '..')
const applications = {
  server: {
    executable: path.join(root, 'dist', 'server-build', 'win-unpacked', 'RED vs BLUE Server.exe'),
    helperExecutables: [path.join(root, 'dist', 'server-build', 'win-unpacked', 'resources', 'node.exe')],
    userDataDir: process.env.RVB_SMOKE_USER_DATA_DIR
      ? path.resolve(process.env.RVB_SMOKE_USER_DATA_DIR)
      : null,
    title: 'RED vs BLUE Server',
    debugPort: 19221,
  },
  client: {
    executable: path.join(root, 'dist', 'client-build', 'win-unpacked', 'RED vs BLUE.exe'),
    helperExecutables: [path.join(root, 'dist', 'client-build', 'win-unpacked', 'resources', 'node.exe')],
    userDataDir: process.env.RVB_SMOKE_USER_DATA_DIR
      ? path.resolve(process.env.RVB_SMOKE_USER_DATA_DIR)
      : null,
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

function loadContentCandidateFixture() {
  const pointerPath = path.join(
    root,
    'output',
    'validation',
    'RED-118',
    'content-candidate-latest.json',
  )
  if (!existsSync(pointerPath)) {
    execFileSync(process.execPath, [
      path.join(root, 'scripts', 'rvb.mjs'),
      'content-candidate',
      'RED-118',
    ], { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 180000 })
  }
  const candidate = JSON.parse(readFileSync(pointerPath, 'utf8'))
  assert(
    candidate.schemaVersion === 'rvb-red-118-candidate-pointer/v1'
      && candidate.status === 'PASS'
      && /^[0-9a-f]{64}$/.test(candidate.finalProfileHash)
      && /^[0-9a-f]{64}$/.test(candidate.authorityContentHash)
      && /^[0-9a-f]{64}$/.test(candidate.qaKeyId)
      && candidate.contentAbi === 'rvb-content/v1'
      && existsSync(candidate.fixture?.image?.sourceDir)
      && existsSync(candidate.fixture?.image?.signedArchive)
      && existsSync(candidate.fixture?.pve?.sourceDir)
      && existsSync(candidate.fixture?.pve?.signedArchive),
    `Invalid RED-118 content candidate pointer: ${pointerPath}`,
  )
  return candidate
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

async function evaluate(target, expression, awaitPromise = true, timeoutMs = 30000) {
  const connection = await connectTarget(target)
  try {
    return await connection.evaluate(expression, awaitPromise, timeoutMs)
  } finally {
    connection.close()
  }
}

async function evaluateFireAndForget(target, expression) {
  const connection = await connectTarget(target)
  connection.evaluateFireAndForget(expression)
  await delay(50)
  connection.close()
}

async function waitForPackStatus(application, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${application.debugPort}/json`)
      const target = targets.find((candidate) => candidate.url.startsWith('rvb-client://app/index.html'))
      if (target) {
        const status = await evaluate(target, 'window.electronAPI.packList()', true, 10000)
        observed = status
        if (predicate(status)) return { target, status }
      }
    } catch {}
    await delay(250)
  }
  throw new Error(`Profile status did not converge: ${JSON.stringify(observed)}`)
}

let nextRendererNavigationId = 0

async function beginProfileNavigation(target, expression) {
  const marker = `red118-navigation-${process.pid}-${Date.now()}-${++nextRendererNavigationId}`
  await evaluateFireAndForget(
    target,
    `window.__rvbRed118NavigationMarker = ${JSON.stringify(marker)}; void (${expression})`,
  )
  return marker
}

async function waitForGameRendererAfterNavigation(application, marker, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let observedTargets = []
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${application.debugPort}/json`)
      observedTargets = targets.map(({ title, type, url }) => ({ title, type, url }))
      const target = targets.find(candidate => candidate.url.startsWith('rvb-client://app/index.html'))
      if (target) {
        const state = await evaluate(target, `({
          markerCleared: window.__rvbRed118NavigationMarker !== ${JSON.stringify(marker)},
          readyState: document.readyState
        })`, true, 5000)
        if (state?.markerCleared === true && state.readyState === 'complete') return target
      }
    } catch {}
    await delay(250)
  }
  throw new Error(
    `Game renderer did not finish navigation for ${marker}: ${JSON.stringify(observedTargets)}`,
  )
}

async function waitForActivationTransaction(activePath, targetProfileHash, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    try {
      observed = JSON.parse(readFileSync(activePath, 'utf8'))
      if (observed.activation?.targetProfileHash === targetProfileHash) return observed.activation
    } catch {}
    await delay(2)
  }
  throw new Error(`Activation transaction did not appear for ${targetProfileHash}: ${JSON.stringify(observed)}`)
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
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    })
    const result = await response.json()
    return response.ok && result.ok === true && ['rvb-ws', 'rvb-colyseus'].includes(result.protocol)
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
        protocolVersion: 3,
        authorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
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
    cwd: application.workingDirectory,
    detached: true,
    stdio: process.env.RVB_SMOKE_CHILD_STDIO === 'inherit' ? 'inherit' : 'ignore',
    windowsHide: true,
    env: application.userDataDir
      ? {
          ...(application.environment ?? process.env),
          RVB_ELECTRON_USER_DATA_DIR: path.resolve(application.userDataDir),
        }
      : (application.environment ?? process.env),
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

async function smokeServer(expectedIdentity = null, sharedUserDataDir = null) {
  const application = applications.server
  const originalUserDataDir = application.userDataDir
  const configuredUserDataDir = sharedUserDataDir ?? process.env.RVB_SMOKE_USER_DATA_DIR
  const userDataDir = configuredUserDataDir
    ? path.resolve(configuredUserDataDir)
    : mkdtempSync(path.join(tmpdir(), 'rvb-server-windows-smoke-'))
  const ownsUserDataDir = !configuredUserDataDir
  application.userDataDir = userDataDir
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
    const resourcePackStatus = await evaluate(target, `window.electronAPI.getResourcePackStatus()`)
    const health = await callGameRpc(
      'ws://127.0.0.1:3000/ws/rooms/__lobby',
      'system.health',
      {},
    )
    const catalogIdentity = await callGameRpc(
      'ws://127.0.0.1:3000/ws/rooms/__lobby',
      'catalog.identity',
      {},
    )
    const rooms = await callGameRpc(
      'ws://127.0.0.1:3000/ws/rooms/__lobby',
      'rooms.list',
      {},
    )
    const publicWebSocket = await probeGameWebSocket(
      'ws://127.0.0.1:3000/ws/rooms/__lobby',
    )
    assert(
      health.ok === true && health.data?.protocol === 'rvb-ws',
      'Public same-port WebSocket system.health failed: ' + JSON.stringify(health),
    )
    if (expectedIdentity) {
      assert(
        catalogIdentity.data?.profileIdentity?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
          && catalogIdentity.data?.profileIdentity?.authorityContentHash === expectedIdentity.authorityContentHash
          && catalogIdentity.data?.profileIdentity?.engineAbi === expectedIdentity.engineAbi,
        `Standalone Server Profile identity mismatch: ${JSON.stringify(catalogIdentity.data?.profileIdentity)}`,
      )
      assert(
        resourcePackStatus?.state?.stable?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
          && resourcePackStatus.state.stable.authorityContentHash === expectedIdentity.authorityContentHash
          && resourcePackStatus.state.stable.compatibility?.engineAbi === expectedIdentity.engineAbi
          && resourcePackStatus.state.stable.compatibility?.contentAbi === expectedIdentity.contentAbi
          && resourcePackStatus.server?.profile?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
          && resourcePackStatus.server.profile.authorityContentHash === expectedIdentity.authorityContentHash
          && resourcePackStatus.server.profile.compatibility?.engineAbi === expectedIdentity.engineAbi
          && resourcePackStatus.server.profile.compatibility?.contentAbi === expectedIdentity.contentAbi,
        `Standalone Server runtime Profile reference mismatch: ${JSON.stringify(resourcePackStatus)}`,
      )
    }
    assert(
      rooms.ok === true && Array.isArray(rooms.data?.rooms),
      'Public same-port WebSocket rooms.list failed: ' + JSON.stringify(rooms),
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
      websocketRpc: {
        health,
        catalogIdentity,
        rooms,
      },
      publicWebSocket,
      profileIdentity: catalogIdentity.data?.profileIdentity,
      resourcePackStatus,
      rejectedNavigation,
      stopped: true,
      port3000Reachable: false,
      helperProcessCountsAfterStop: helperProcessCounts,
    }
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    await waitForExecutableCleanup([application.executable, ...(application.helperExecutables ?? [])])
    application.userDataDir = originalUserDataDir
    if (ownsUserDataDir) rmSync(userDataDir, { recursive: true, force: true })
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

async function smokeClient(expectedIdentity = null, sharedUserDataDir = null) {
  const application = applications.client
  const sourcePackageRoot = path.dirname(application.executable)
  const isolatedPackageBase = mkdtempSync(path.join(tmpdir(), 'rvb-client-package-smoke-'))
  const isolatedPackageRoot = path.join(isolatedPackageBase, 'win-unpacked')
  const relativePackageBaseToTemp = path.relative(path.resolve(tmpdir()), path.resolve(isolatedPackageBase))
  assert(
    relativePackageBaseToTemp.length > 0
      && !relativePackageBaseToTemp.startsWith('..' + path.sep)
      && !path.isAbsolute(relativePackageBaseToTemp),
    `Client smoke package base must be owned under the system temp directory: ${isolatedPackageBase}`,
  )
  const originalExecutable = application.executable
  const originalHelperExecutables = application.helperExecutables
  const originalUserDataDir = application.userDataDir
  const configuredUserDataDir = sharedUserDataDir ?? process.env.RVB_SMOKE_USER_DATA_DIR
  const userDataDir = configuredUserDataDir
    ? path.resolve(configuredUserDataDir)
    : mkdtempSync(path.join(tmpdir(), 'rvb-client-windows-smoke-'))
  const ownsUserDataDir = !configuredUserDataDir
  application.userDataDir = userDataDir
  let smokeError = null
  try {
    assert(existsSync(sourcePackageRoot), `Missing source client package: ${sourcePackageRoot}`)
    cpSync(sourcePackageRoot, isolatedPackageRoot, { recursive: true })
    const relativeToRepository = path.relative(root, isolatedPackageRoot)
    assert(
      relativeToRepository.startsWith('..' + path.sep) || path.isAbsolute(relativeToRepository),
      `Client smoke package must be outside the repository: ${isolatedPackageRoot}`,
    )
    application.executable = path.join(isolatedPackageRoot, 'RED vs BLUE.exe')
    application.helperExecutables = [
      path.join(isolatedPackageRoot, 'resources', 'node.exe'),
      path.join(isolatedPackageRoot, 'resources', 'postgres', 'pgsql', 'bin', 'postgres.exe'),
    ]
    assert(
      existsSync(path.join(isolatedPackageRoot, 'resources', 'app', 'standalone', 'node_modules', 'next', 'package.json')),
      'Isolated client package is missing the standalone Next.js runtime',
    )
    assert(
      existsSync(path.join(isolatedPackageRoot, 'resources', 'app', 'standalone', 'node_modules', 'ws', 'package.json')),
      'Isolated client package is missing the standalone WebSocket runtime',
    )
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
    // A cold machine may spend tens of seconds in Windows Defender scanning,
    // runtime integrity verification and first-cluster initdb. This is startup
    // work, not the gameplay latency budget.
    const gameTarget = await waitForTargets(
      application.debugPort,
      candidate => candidate.url.startsWith('rvb-client://app/index.html'),
      60_000,
    )
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
    const legacyPlayerRestResponse = await fetch(`${localBaseUrl}/api/rooms`, {
      signal: AbortSignal.timeout(2000),
    })
    const legacyPlayerRestBody = await legacyPlayerRestResponse.text()
    assert(
      legacyPlayerRestResponse.status === 404,
      `Legacy player REST boundary was not disabled: ${legacyPlayerRestResponse.status} ${legacyPlayerRestBody.slice(0, 200)}`,
    )
    const catalogIdentityResponse = await fetch(`${localBaseUrl}/catalog/identity`, {
      signal: AbortSignal.timeout(2000),
    })
    const catalogIdentity = { ok: catalogIdentityResponse.ok, data: await catalogIdentityResponse.json() }
    const resourcePackStatus = await evaluate(gameTarget, `window.electronAPI.packList()`)
    assert(
      catalogIdentity.ok === true
        && typeof catalogIdentity.data?.profileIdentity?.resolvedProfileHash === 'string'
        && typeof catalogIdentity.data?.profileIdentity?.authorityContentHash === 'string',
      `Fresh client did not expose its resolved Profile identity: ${JSON.stringify(catalogIdentity)}`,
    )
    if (expectedIdentity) {
      assert(
        catalogIdentity.data.profileIdentity.resolvedProfileHash === expectedIdentity.resolvedProfileHash
          && catalogIdentity.data.profileIdentity.authorityContentHash === expectedIdentity.authorityContentHash
          && catalogIdentity.data.profileIdentity.engineAbi === expectedIdentity.engineAbi,
        `Packaged Client Profile identity mismatch: ${JSON.stringify(catalogIdentity.data.profileIdentity)}`,
      )
      assert(
        resourcePackStatus?.state?.stable?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
          && resourcePackStatus.state.stable.authorityContentHash === expectedIdentity.authorityContentHash
          && resourcePackStatus.state.stable.compatibility?.engineAbi === expectedIdentity.engineAbi
          && resourcePackStatus.state.stable.compatibility?.contentAbi === expectedIdentity.contentAbi
          && resourcePackStatus.server?.profile?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
          && resourcePackStatus.server.profile.authorityContentHash === expectedIdentity.authorityContentHash
          && resourcePackStatus.server.profile.compatibility?.engineAbi === expectedIdentity.engineAbi
          && resourcePackStatus.server.profile.compatibility?.contentAbi === expectedIdentity.contentAbi,
        `Packaged Client runtime Profile reference mismatch: ${JSON.stringify(resourcePackStatus)}`,
      )
    }
    const roomsBeforeCreateResponse = await fetch(`${localBaseUrl}/rooms`, {
      signal: AbortSignal.timeout(2000),
    })
    const roomsBeforeCreate = { ok: roomsBeforeCreateResponse.ok, data: await roomsBeforeCreateResponse.json() }
    assert(
      roomsBeforeCreate.ok === true
        && Array.isArray(roomsBeforeCreate.data?.rooms)
        && roomsBeforeCreate.data.rooms.length === 0,
      `Fresh client database did not return an empty room list: ${JSON.stringify(roomsBeforeCreate)}`,
    )
    const colyseusClient = new ColyseusClient(`ws://127.0.0.1:${localGatewayPort}`)
    const smokeRoom = await colyseusClient.create('battle', {
      product: true,
      playerId: 'red161-windows-smoke',
      playerName: 'RED-161 Windows smoke',
      name: 'RED-161 Windows smoke room',
      mapId: 'winding-pass',
      visibility: 'public',
      profileIdentity: catalogIdentity.data.profileIdentity,
    })
    const createdRoom = {
      ok: true,
      data: { id: smokeRoom.roomId, mapId: 'winding-pass' },
    }
    assert(
      createdRoom.ok === true
        && typeof createdRoom.data?.id === 'string'
        && createdRoom.data?.mapId === 'winding-pass',
      `Fresh client database could not create a room: ${JSON.stringify(createdRoom)}`,
    )
    const roomsAfterCreateResponse = await fetch(`${localBaseUrl}/rooms`, {
      signal: AbortSignal.timeout(2000),
    })
    const roomsAfterCreate = { ok: roomsAfterCreateResponse.ok, data: await roomsAfterCreateResponse.json() }
    assert(
      roomsAfterCreate.ok === true
        && Array.isArray(roomsAfterCreate.data?.rooms)
        && roomsAfterCreate.data.rooms.some((room) => room.id === createdRoom.data.id),
      `Created room was not persisted in the client database: ${JSON.stringify(roomsAfterCreate)}`,
    )
    await smokeRoom.leave()
    const pieceGallery = await verifyPieceGallery(application.debugPort, gameTarget)
    const battle = await verifyBattleTerminalError(application.debugPort, pieceGallery.target)
    assert(battle.runtime.readyState === 'complete', `Battle page did not finish loading: ${JSON.stringify(battle.runtime)}`)
    assert(battle.runtime.messageColor === 'rgb(248, 113, 113)', `Battle page did not style its terminal error: ${JSON.stringify(battle.runtime)}`)
    assert(battle.runtime.spinnerDisplay === 'none', `Battle page kept spinning after a terminal error: ${JSON.stringify(battle.runtime)}`)
    await evaluateFireAndForget(battle.target, 'window.close()')
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
      isolatedPackageRoot,
      rendererBoundary,
      invalidTlsCertificate: tlsProbe,
      homepageWindowBoundary,
      packagedAssets,
      localMode: mode,
      profileIdentity: catalogIdentity.data.profileIdentity,
      resourcePackStatus,
      databaseProbe: { roomsBeforeCreate, createdRoom, roomsAfterCreate },
      legacyPlayerRest: { status: legacyPlayerRestResponse.status },
      pieceGallery: { all: pieceGallery.all, light: pieceGallery.light, dark: pieceGallery.dark },
      battleRuntime: battle.runtime,
      exitedCleanly: true,
      processCountsAfterExit,
    }))
  } catch (error) {
    smokeError = error
    throw error
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    application.executable = originalExecutable
    application.helperExecutables = originalHelperExecutables
    application.userDataDir = originalUserDataDir
    try {
      if (ownsUserDataDir) rmSync(userDataDir, { recursive: true, force: true })
      rmSync(isolatedPackageBase, { recursive: true, force: true })
    } catch (cleanupError) {
      if (!smokeError) throw cleanupError
      console.error(`[RVB smoke] Cleanup also failed after the primary error: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`)
    }
  }
}

async function smokeProfileActivation(candidate, sharedUserDataDir = null) {
  const application = applications.client
  const sourcePackageRoot = path.dirname(application.executable)
  const isolatedPackageBase = mkdtempSync(path.join(tmpdir(), 'rvb-red118-profile-package-'))
  const isolatedPackageRoot = path.join(isolatedPackageBase, 'win-unpacked')
  const userDataDir = sharedUserDataDir
    ? path.resolve(sharedUserDataDir)
    : mkdtempSync(path.join(tmpdir(), 'rvb-red118-profile-user-'))
  const ownsUserDataDir = !sharedUserDataDir
  const originalExecutable = application.executable
  const originalHelperExecutables = application.helperExecutables
  const originalUserDataDir = application.userDataDir
  let faultedPayloadPath = null
  let faultedPayloadBytes = null
  try {
    cpSync(sourcePackageRoot, isolatedPackageRoot, { recursive: true })
    application.executable = path.join(isolatedPackageRoot, 'RED vs BLUE.exe')
    application.helperExecutables = [path.join(isolatedPackageRoot, 'resources', 'node.exe')]
    application.userDataDir = userDataDir

    const { target: connectTargetDescriptor, rendererBoundary } = await launch(application, 45000)
    await evaluate(connectTargetDescriptor, 'window.electronAPI.openLocalGame(); true', false)
    const initialGameTarget = await waitForTargets(
      application.debugPort,
      (candidate) => candidate.url.startsWith('rvb-client://app/index.html'),
      30000,
    )

    const initial = await waitForPackStatus(application, (status) => (
      status?.ok === true
      && status.server?.healthy === true
      && status.state?.activation === null
      && status.state?.stable?.resolvedProfileHash === status.server?.profile?.resolvedProfileHash
    ))
    const profileAHash = initial.status.state.stable.resolvedProfileHash
    assert(initial.status.state.stable.kind === 'bundled-base', 'Profile A must start as Bundled Base')

    assert(
      profileAHash === candidate.baseProfileHash,
      `Candidate Base identity mismatch: ${profileAHash} / ${candidate.baseProfileHash}`,
    )
    const imageArchive = readFileSync(candidate.fixture.image.signedArchive)
    const imageInstalled = await evaluate(
      initialGameTarget,
      `window.electronAPI.packImportData(${JSON.stringify(imageArchive.toString('base64'))}, 'red-118-image-patch.rvbpack')`,
      true,
      60000,
    )
    assert(imageInstalled?.ok === true, `Image Profile installation failed: ${JSON.stringify(imageInstalled)}`)
    assert(
      imageInstalled.reloadMode === 'presentation-refresh',
      `Image Profile did not use presentation refresh: ${JSON.stringify(imageInstalled)}`,
    )
    const imageProfileHash = imageInstalled.profile?.resolvedProfileHash
    assert(
      imageProfileHash === candidate.imageProfileHash,
      `Installed image Profile mismatch: ${imageProfileHash} / ${candidate.imageProfileHash}`,
    )
    const imageInstalledStatus = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === profileAHash
      && status.state?.candidate?.resolvedProfileHash === imageProfileHash
    ))
    const imageActivationMarker = await beginProfileNavigation(
      imageInstalledStatus.target,
      `window.electronAPI.packActivate(${JSON.stringify(imageProfileHash)})`,
    )
    await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === imageProfileHash
      && status.state?.previousStable?.resolvedProfileHash === profileAHash
      && status.state?.candidate === null
      && status.state?.activation === null
      && status.server?.healthy === true
    ))
    const imageActivatedTarget = await waitForGameRendererAfterNavigation(
      application,
      imageActivationMarker,
    )
    const pveArchive = readFileSync(candidate.fixture.pve.signedArchive)
    const installed = await evaluate(
      imageActivatedTarget,
      `window.electronAPI.packImportData(${JSON.stringify(pveArchive.toString('base64'))}, 'red-118-pve-patch.rvbpack')`,
      true,
      60000,
    )
    assert(installed?.ok === true, `PVE Profile installation failed: ${JSON.stringify(installed)}`)
    assert(
      installed.reloadMode === 'authority-restart',
      `PVE Profile did not require authority restart: ${JSON.stringify(installed)}`,
    )
    const profileBHash = installed.profile?.resolvedProfileHash
    assert(
      profileBHash === candidate.finalProfileHash,
      `Installed final Profile mismatch: ${profileBHash} / ${candidate.finalProfileHash}`,
    )
    const installedStatus = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === imageProfileHash
      && status.state?.candidate?.resolvedProfileHash === profileBHash
    ))
    const activePath = path.join(userDataDir, 'resource-pack', 'active.json')
    const faultedRelativePath = 'data/cards/lucky-coin.json'
    faultedPayloadPath = path.join(
      userDataDir,
      'resource-pack',
      'profiles',
      profileBHash,
      ...faultedRelativePath.split('/'),
    )
    faultedPayloadBytes = readFileSync(faultedPayloadPath)

    await evaluateFireAndForget(
      installedStatus.target,
      `void window.electronAPI.packActivate(${JSON.stringify(profileBHash)})`,
    )
    const interruptedActivation = await waitForActivationTransaction(activePath, profileBHash)
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    const processCountsAfterInterrupt = await waitForExecutableCleanup([
      application.executable,
      ...(application.helperExecutables ?? []),
    ])
    assert(
      Object.values(processCountsAfterInterrupt).every((count) => count === 0),
      `Interrupted candidate left residual processes: ${JSON.stringify(processCountsAfterInterrupt)}`,
    )

    const { target: recoveryConnectTarget } = await launch(application, 45000)
    await evaluate(recoveryConnectTarget, 'window.electronAPI.openLocalGame(); true', false)
    await waitForTargets(
      application.debugPort,
      (candidate) => candidate.url.startsWith('rvb-client://app/index.html'),
      30000,
    )
    const recovered = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === imageProfileHash
      && status.state?.candidate?.resolvedProfileHash === profileBHash
      && status.state?.activation === null
      && status.state?.lastFailure?.code === 'ACTIVATION_INTERRUPTED'
      && status.state?.lastFailure?.stage === 'startup-recovery'
      && status.state?.lastFailure?.targetProfileHash === profileBHash
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === imageProfileHash
    ))

    await evaluateFireAndForget(
      recovered.target,
      `void window.electronAPI.packActivate(${JSON.stringify(profileBHash)})`,
    )
    const failedActivation = await waitForActivationTransaction(activePath, profileBHash)
    unlinkSync(faultedPayloadPath)

    const failed = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === imageProfileHash
      && status.state?.candidate?.resolvedProfileHash === profileBHash
      && status.state?.activation === null
      && status.state?.lastFailure?.targetProfileHash === profileBHash
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === imageProfileHash
    ))
    assert(
      failed.status.state.lastFailure.stage === 'candidate-server-health',
      `Injected B failure happened at an unexpected stage: ${JSON.stringify(failed.status.state.lastFailure)}`,
    )
    assert(
      failed.status.state.lastFailure.message === 'CANDIDATE_SERVER_IDENTITY_OR_HEALTH_MISMATCH',
      `Injected B failure had an unexpected cause: ${JSON.stringify(failed.status.state.lastFailure)}`,
    )

    writeFileSync(faultedPayloadPath, faultedPayloadBytes)
    assert(
      readFileSync(faultedPayloadPath).equals(faultedPayloadBytes),
      `Faulted Profile payload did not restore byte-for-byte: ${faultedRelativePath}`,
    )
    faultedPayloadPath = null
    faultedPayloadBytes = null

    const restoredInstall = await evaluate(
      failed.target,
      `window.electronAPI.packImportData(${JSON.stringify(pveArchive.toString('base64'))}, 'red-118-pve-patch-restored.rvbpack')`,
      true,
      60000,
    )
    assert(
      restoredInstall?.ok === true
        && restoredInstall.profile?.resolvedProfileHash === profileBHash,
      `Restored PVE Profile did not pass canonical re-import verification: ${JSON.stringify(restoredInstall)}`,
    )
    const restored = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === imageProfileHash
      && status.state?.candidate?.resolvedProfileHash === profileBHash
      && status.state?.activation === null
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === imageProfileHash
    ))

    const finalActivationMarker = await beginProfileNavigation(
      restored.target,
      `window.electronAPI.packActivate(${JSON.stringify(profileBHash)})`,
    )
    const activated = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === profileBHash
      && status.state?.previousStable?.resolvedProfileHash === imageProfileHash
      && status.state?.candidate === null
      && status.state?.activation === null
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === profileBHash
    ))
    const activatedTarget = await waitForGameRendererAfterNavigation(
      application,
      finalActivationMarker,
    )

    const previousRollbackMarker = await beginProfileNavigation(
      activatedTarget,
      "window.electronAPI.packRollback('previous-stable')",
    )
    const rolledBack = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === imageProfileHash
      && status.state?.previousStable?.resolvedProfileHash === profileBHash
      && status.state?.candidate === null
      && status.state?.activation === null
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === imageProfileHash
    ))
    const rolledBackTarget = await waitForGameRendererAfterNavigation(
      application,
      previousRollbackMarker,
    )

    const finalRollbackMarker = await beginProfileNavigation(
      rolledBackTarget,
      "window.electronAPI.packRollback('previous-stable')",
    )
    const finalActivated = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === profileBHash
      && status.state?.previousStable?.resolvedProfileHash === imageProfileHash
      && status.state?.candidate === null
      && status.state?.activation === null
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === profileBHash
      && status.server?.profile?.authorityContentHash === candidate.authorityContentHash
    ))
    const finalActivatedTarget = await waitForGameRendererAfterNavigation(
      application,
      finalRollbackMarker,
    )

    await evaluateFireAndForget(finalActivatedTarget, 'window.close()')
    const processCountsAfterExit = await waitForExecutableCleanup([
      application.executable,
      ...(application.helperExecutables ?? []),
    ])
    assert(
      Object.values(processCountsAfterExit).every((count) => count === 0),
      `Profile activation candidate left residual processes: ${JSON.stringify(processCountsAfterExit)}`,
    )
    console.log(JSON.stringify({
      entry: 'profile',
      rendererBoundary,
      profileAHash,
      imageProfileHash,
      profileBHash,
      finalProfileHash: candidate.finalProfileHash,
      authorityContentHash: candidate.authorityContentHash,
      imagePackageHash: candidate.imagePackageHash,
      pvePackageHash: candidate.pvePackageHash,
      interruptedActivationId: interruptedActivation.activationId,
      stableAfterInterruptRecovery: recovered.status.state.stable.resolvedProfileHash,
      serverAfterInterruptRecovery: recovered.status.server.profile.resolvedProfileHash,
      processCountsAfterInterrupt,
      failedActivationId: failedActivation.activationId,
      failedStage: failed.status.state.lastFailure.stage,
      stableAfterFailure: failed.status.state.stable.resolvedProfileHash,
      stableAfterSuccess: activated.status.state.stable.resolvedProfileHash,
      stableAfterRollback: rolledBack.status.state.stable.resolvedProfileHash,
      serverAfterRollback: rolledBack.status.server.profile.resolvedProfileHash,
      stableForFourEntryParity: finalActivated.status.state.stable.resolvedProfileHash,
      serverForFourEntryParity: finalActivated.status.server.profile.resolvedProfileHash,
      exitedCleanly: true,
      processCountsAfterExit,
    }))
    return {
      resolvedProfileHash: candidate.finalProfileHash,
      authorityContentHash: candidate.authorityContentHash,
      engineAbi: candidate.engineAbi,
      contentAbi: candidate.contentAbi,
      baseProfileHash: profileAHash,
    }
  } finally {
    if (faultedPayloadPath && faultedPayloadBytes && !existsSync(faultedPayloadPath)) {
      writeFileSync(faultedPayloadPath, faultedPayloadBytes)
    }
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    application.executable = originalExecutable
    application.helperExecutables = originalHelperExecutables
    application.userDataDir = originalUserDataDir
    if (ownsUserDataDir) rmSync(userDataDir, { recursive: true, force: true })
    rmSync(isolatedPackageBase, { recursive: true, force: true })
  }
}

async function rollbackSharedCandidateToBase(expectedIdentity, userDataDir) {
  const application = applications.client
  const originalUserDataDir = application.userDataDir
  application.userDataDir = path.resolve(userDataDir)
  try {
    const { target } = await launch(application, 45000)
    await evaluate(target, 'window.electronAPI.openLocalGame(); true', false)
    await waitForTargets(
      application.debugPort,
      (candidate) => candidate.url.startsWith('rvb-client://app/index.html'),
      30000,
    )
    const active = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === expectedIdentity.resolvedProfileHash
    ))
    const baseRollbackMarker = await beginProfileNavigation(
      active.target,
      "window.electronAPI.packRollback('bundled-base')",
    )
    const rolledBack = await waitForPackStatus(application, (status) => (
      status?.state?.stable?.resolvedProfileHash === expectedIdentity.baseProfileHash
      && status.state?.candidate === null
      && status.state?.activation === null
      && status.server?.healthy === true
      && status.server?.profile?.resolvedProfileHash === expectedIdentity.baseProfileHash
    ))
    const rolledBackTarget = await waitForGameRendererAfterNavigation(
      application,
      baseRollbackMarker,
    )
    await evaluateFireAndForget(rolledBackTarget, 'window.close()')
    assert(
      await waitForDebuggerExit(application.debugPort),
      'Final Base rollback left the Client process reachable',
    )
    console.log(JSON.stringify({
      entry: 'profile-base-rollback',
      fromProfileHash: expectedIdentity.resolvedProfileHash,
      stableAfterRollback: rolledBack.status.state.stable.resolvedProfileHash,
      serverAfterRollback: rolledBack.status.server.profile.resolvedProfileHash,
      exitedCleanly: true,
    }))
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    application.userDataDir = originalUserDataDir
  }
}

function assertOwnedChild(ownerRoot, candidatePath, label) {
  const owner = path.resolve(ownerRoot)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(owner, candidate)
  assert(
    relative.length > 0
      && !relative.startsWith('..' + path.sep)
      && !path.isAbsolute(relative),
    `${label} must stay under its owned temporary root: ${candidate}`,
  )
  return candidate
}

const EDITOR_UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

function editorUninstallRegistrations() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const registryTool = path.join(systemRoot, 'System32', 'reg.exe')
  const matches = []
  for (const registryRoot of EDITOR_UNINSTALL_ROOTS) {
    const probe = spawnSync(registryTool, [
      'query', registryRoot, '/s', '/f', 'RED vs BLUE Editor',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    })
    if (probe.error) throw probe.error
    if (probe.status === 0) matches.push(registryRoot)
    else if (probe.status !== 1) {
      throw new Error(`Editor uninstall registry probe failed (${registryRoot}): ${probe.status}`)
    }
  }
  return matches
}

async function waitForEditorUnregistered(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let observed = editorUninstallRegistrations()
  while (observed.length > 0 && Date.now() < deadline) {
    await delay(250)
    observed = editorUninstallRegistrations()
  }
  return observed
}

async function waitForPathRemoval(targetPath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (existsSync(targetPath) && Date.now() < deadline) await delay(250)
  return !existsSync(targetPath)
}

function hermeticEditorEnvironment(emptyPathDirectory) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase()
    if (
      upper === 'PATH'
      || upper === 'NODE'
      || upper === 'NODE_PATH'
      || upper === 'NODE_OPTIONS'
      || upper === 'ELECTRON_RUN_AS_NODE'
      || upper === 'APP_ROOT_DIR'
      || upper === 'INIT_CWD'
      || upper === 'PWD'
      || upper.startsWith('RVB_')
      || upper.startsWith('NPM_')
    ) delete environment[key]
  }
  environment.Path = path.resolve(emptyPathDirectory)
  return environment
}

function assertNoNodeOnPath(environment, workingDirectory) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const whereTool = path.join(systemRoot, 'System32', 'where.exe')
  const probe = spawnSync(whereTool, ['/Q', 'node.exe'], {
    cwd: workingDirectory,
    env: environment,
    windowsHide: true,
    stdio: 'ignore',
    timeout: 10000,
  })
  if (probe.error) throw probe.error
  assert(probe.status === 1, `Editor hermetic PATH exposed node.exe (where exit ${probe.status})`)
}

async function smokeEditorDistribution(candidate, distribution) {
  const application = applications.editor
  const originalExecutable = application.executable
  const originalLaunchArguments = application.launchArguments
  const originalWorkingDirectory = application.workingDirectory
  const originalEnvironment = application.environment
  const userDataDir = path.resolve(distribution.userDataDir)
  const authoringRoot = path.join(userDataDir, 'content-authoring')
  const keyFile = path.join(authoringRoot, 'keys', 'qa.key')
  try {
    application.executable = path.resolve(distribution.executable)
    application.launchArguments = [`--user-data-dir=${userDataDir}`]
    application.workingDirectory = path.resolve(distribution.workingDirectory)
    application.environment = distribution.environment
    const imageSource = path.join(authoringRoot, 'sources', 'candidate-image')
    const pveSource = path.join(authoringRoot, 'sources', 'candidate-pve')
    mkdirSync(path.dirname(imageSource), { recursive: true })
    mkdirSync(path.dirname(keyFile), { recursive: true })
    cpSync(candidate.fixture.image.sourceDir, imageSource, { recursive: true })
    cpSync(candidate.fixture.pve.sourceDir, pveSource, { recursive: true })
    writeFileSync(keyFile, `${'31'.repeat(32)}\n`, 'utf8')

    const startedAt = Date.now()
    const { target, rendererBoundary } = await launch(application, 300000)
    const startupMilliseconds = Date.now() - startedAt
    const counts = await evaluate(target, `Promise.all(['pieces', 'skills', 'cards', 'rules'].map(async (directory) => [directory, (await window.editorAPI.listFiles(directory)).length]))`)
    assert(counts.every(([, count]) => count > 0), `Editor could not list packaged data files: ${JSON.stringify(counts)}`)
    const visibleOperations = await evaluate(target, `({
      tabs: [...document.querySelectorAll('[data-pipeline-operation]')].map((node) => node.dataset.pipelineOperation),
      forms: [...document.querySelectorAll('[data-operation-form]')].map((node) => node.dataset.operationForm),
      actions: [...document.querySelectorAll('[data-run-operation]')].map((node) => node.dataset.runOperation)
    })`)
    const expectedOperations = ['build', 'sign', 'validate', 'resolve', 'smoke']
    assert(
      expectedOperations.every(operation => visibleOperations.tabs.includes(operation)
        && visibleOperations.forms.includes(operation)
        && visibleOperations.actions.includes(operation)),
      `Packaged Editor does not expose the full visible operation chain: ${JSON.stringify(visibleOperations)}`,
    )
    const imageBuild = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'build',
      taskId: 'RED-118',
      channel: 'local-dev',
      ...candidate.fixture.image.build,
      source: 'sources/candidate-image',
      output: 'archives/image-unsigned.rvbpack',
      compressionLevel: 9,
    })})`, true, 180000)
    assert(imageBuild?.ok === true, `Packaged Editor image build failed: ${JSON.stringify(imageBuild)}`)
    assert(
      imageBuild.report?.identity?.packageHash === candidate.imageUnsignedPackageHash,
      `CLI/Editor image build hash mismatch: ${candidate.imageUnsignedPackageHash} / ${imageBuild.report?.identity?.packageHash}`,
    )
    const imageSign = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'sign',
      taskId: 'RED-118',
      channel: 'qa',
      input: 'archives/image-unsigned.rvbpack',
      output: 'archives/image-qa.rvbpack',
      keyFile: 'keys/qa.key',
    })})`, true, 180000)
    assert(
      imageSign?.ok === true
        && imageSign.report?.identity?.packageHash === candidate.imagePackageHash
        && imageSign.report?.identity?.publisherKeyId === candidate.qaKeyId,
      `Packaged Editor image sign parity failed: ${JSON.stringify(imageSign)}`,
    )
    const imageValidation = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'validate',
      taskId: 'RED-118',
      channel: 'qa',
      archive: 'archives/image-qa.rvbpack',
      base: 'bundled',
      patches: [],
      trustedKeyIds: [candidate.qaKeyId],
    })})`, true, 180000)
    assert(imageValidation?.ok === true, `Packaged Editor image validation failed: ${JSON.stringify(imageValidation)}`)

    const pveBuild = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'build',
      taskId: 'RED-118',
      channel: 'local-dev',
      ...candidate.fixture.pve.build,
      source: 'sources/candidate-pve',
      output: 'archives/pve-unsigned.rvbpack',
      compressionLevel: 0,
    })})`, true, 180000)
    assert(
      pveBuild?.ok === true
        && pveBuild.report?.identity?.packageHash === candidate.pveUnsignedPackageHash,
      `Packaged Editor PVE build parity failed: ${JSON.stringify(pveBuild)}`,
    )
    const pveSign = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'sign',
      taskId: 'RED-118',
      channel: 'qa',
      input: 'archives/pve-unsigned.rvbpack',
      output: 'archives/pve-qa.rvbpack',
      keyFile: 'keys/qa.key',
    })})`, true, 180000)
    assert(
      pveSign?.ok === true
        && pveSign.report?.identity?.packageHash === candidate.pvePackageHash,
      `Packaged Editor PVE sign parity failed: ${JSON.stringify(pveSign)}`,
    )
    const pveValidation = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'validate',
      taskId: 'RED-118',
      channel: 'qa',
      archive: 'archives/pve-qa.rvbpack',
      base: 'bundled',
      patches: ['archives/image-qa.rvbpack'],
      trustedKeyIds: [candidate.qaKeyId],
    })})`, true, 180000)
    assert(pveValidation?.ok === true, `Packaged Editor PVE validation failed: ${JSON.stringify(pveValidation)}`)
    const editorResolve = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'resolve',
      taskId: 'RED-118',
      channel: 'qa',
      base: 'bundled',
      patches: ['archives/image-qa.rvbpack', 'archives/pve-qa.rvbpack'],
      trustedKeyIds: [candidate.qaKeyId],
    })})`, true, 180000)
    assert(
      editorResolve?.ok === true
        && editorResolve.report?.identity?.resolvedProfileHash === candidate.finalProfileHash
        && editorResolve.report?.identity?.authorityContentHash === candidate.authorityContentHash
        && editorResolve.report?.identity?.engineAbi === candidate.engineAbi
        && editorResolve.report?.identity?.contentAbi === candidate.contentAbi,
      `CLI/Editor resolved Profile identity mismatch: ${JSON.stringify(editorResolve)}`,
    )
    const editorSmoke = await evaluate(target, `window.editorAPI.contentOperation(${JSON.stringify({
      operation: 'smoke',
      taskId: 'RED-118',
      channel: 'qa',
      base: 'bundled',
      patches: ['archives/image-qa.rvbpack', 'archives/pve-qa.rvbpack'],
      trustedKeyIds: [candidate.qaKeyId],
      seed: candidate.seed,
    })})`, true, 180000)
    assert(
      editorSmoke?.ok === true
        && editorSmoke.report?.identity?.resolvedProfileHash === candidate.finalProfileHash
        && editorSmoke.report?.smoke?.terminalResult?.status === 'finished'
        && editorSmoke.report?.smoke?.endOutcome === 'completed',
      `Packaged Editor PVE smoke failed: ${JSON.stringify(editorSmoke)}`,
    )
    rmSync(keyFile, { force: true })
    await evaluateFireAndForget(target, 'window.close()')
    assert(
      await waitForDebuggerExit(application.debugPort),
      `Editor ${distribution.kind} process did not exit after its window closed`,
    )
    console.log(JSON.stringify({
      entry: `editor-${distribution.kind}`,
      distribution: distribution.kind,
      artifact: application.executable,
      startupMilliseconds,
      rendererBoundary,
      dataFileCounts: Object.fromEntries(counts),
      visibleOperations,
      sourceCheckoutUnavailable: true,
      systemNodeUnavailable: true,
      cliImagePackageHash: candidate.imagePackageHash,
      editorImagePackageHash: imageSign.report.identity.packageHash,
      cliPvePackageHash: candidate.pvePackageHash,
      editorPvePackageHash: pveSign.report.identity.packageHash,
      cliResolvedProfileHash: candidate.finalProfileHash,
      editorResolvedProfileHash: editorResolve.report.identity.resolvedProfileHash,
      authorityContentHash: editorResolve.report.identity.authorityContentHash,
      capabilities: editorResolve.report.identity.capabilities,
      signature: editorResolve.report.identity.signature,
      seed: editorSmoke.report.seed,
      terminalResult: editorSmoke.report.smoke.terminalResult,
      finalRunHash: editorSmoke.report.smoke.finalRunHash,
      reportPath: editorSmoke.reportPath,
      exitedCleanly: true,
    }))
  } finally {
    stopApplication(application)
    stopDebugTarget(application.debugPort)
    const processCountsAfterExit = await waitForExecutableCleanup([application.executable], 30000)
    application.executable = originalExecutable
    application.launchArguments = originalLaunchArguments
    application.workingDirectory = originalWorkingDirectory
    application.environment = originalEnvironment
    rmSync(keyFile, { force: true })
    assert(
      Object.values(processCountsAfterExit).every(count => count === 0),
      `Editor ${distribution.kind} left residual processes: ${JSON.stringify(processCountsAfterExit)}`,
    )
  }
}

async function smokeEditor(candidate) {
  const smokeRoot = mkdtempSync(path.join(tmpdir(), 'rvb-red118-editor-distributions-'))
  const relativeSmokeRoot = path.relative(root, smokeRoot)
  assert(
    relativeSmokeRoot.startsWith('..' + path.sep) || path.isAbsolute(relativeSmokeRoot),
    `Editor distribution smoke must run outside the source checkout: ${smokeRoot}`,
  )
  const portableRoot = assertOwnedChild(smokeRoot, path.join(smokeRoot, 'portable'), 'Portable root')
  const portableUserData = assertOwnedChild(smokeRoot, path.join(smokeRoot, 'portable-user'), 'Portable user data')
  const nsisUserData = assertOwnedChild(smokeRoot, path.join(smokeRoot, 'nsis-user'), 'NSIS user data')
  const workingDirectory = assertOwnedChild(smokeRoot, path.join(smokeRoot, 'working'), 'Editor working directory')
  const emptyPathDirectory = assertOwnedChild(smokeRoot, path.join(smokeRoot, 'empty-path'), 'Empty PATH directory')
  const installRoot = assertOwnedChild(smokeRoot, path.join(smokeRoot, 'installed'), 'NSIS install root')
  const portableSource = applications.editor.executable
  const portableExecutable = path.join(portableRoot, path.basename(portableSource))
  const installer = path.join(root, 'dist', 'editor', 'RED vs BLUE Editor Setup 0.1.0.exe')
  const installedExecutable = path.join(installRoot, 'RED vs BLUE Editor.exe')
  const uninstaller = path.join(installRoot, 'Uninstall RED vs BLUE Editor.exe')
  let cleanupSucceeded = false
  let installerStarted = false
  mkdirSync(portableRoot, { recursive: true })
  mkdirSync(portableUserData, { recursive: true })
  mkdirSync(nsisUserData, { recursive: true })
  mkdirSync(workingDirectory, { recursive: true })
  mkdirSync(emptyPathDirectory, { recursive: true })
  assert(existsSync(portableSource), `Missing Editor portable candidate: ${portableSource}`)
  assert(existsSync(installer), `Missing Editor NSIS candidate: ${installer}`)
  assert(editorUninstallRegistrations().length === 0, 'A pre-existing RED vs BLUE Editor installation would make the NSIS smoke destructive')
  cpSync(portableSource, portableExecutable)
  const environment = hermeticEditorEnvironment(emptyPathDirectory)
  assertNoNodeOnPath(environment, workingDirectory)

  try {
    await smokeEditorDistribution(candidate, {
      kind: 'portable',
      executable: portableExecutable,
      userDataDir: portableUserData,
      workingDirectory,
      environment,
    })

    installerStarted = true
    execFileSync(installer, [
      '/S',
      '/currentuser',
      '/no-desktop-shortcut',
      `/D=${installRoot}`,
    ], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 300000,
    })
    assert(existsSync(installedExecutable), `NSIS did not install the Editor executable: ${installedExecutable}`)
    assert(existsSync(uninstaller), `NSIS did not install its owned uninstaller: ${uninstaller}`)
    assertOwnedChild(installRoot, installedExecutable, 'Installed Editor executable')
    assertOwnedChild(installRoot, uninstaller, 'Installed Editor uninstaller')
    assert(editorUninstallRegistrations().length > 0, 'NSIS did not create its current-user uninstall registration')

    await smokeEditorDistribution(candidate, {
      kind: 'nsis',
      executable: installedExecutable,
      userDataDir: nsisUserData,
      workingDirectory,
      environment,
    })
  } finally {
    let cleanupFailure = null
    try {
      if (existsSync(uninstaller)) {
        execFileSync(uninstaller, ['/S', '/currentuser'], {
          cwd: workingDirectory,
          windowsHide: true,
          stdio: 'pipe',
          timeout: 300000,
        })
      } else if (installerStarted && editorUninstallRegistrations().length > 0) {
        throw new Error(`NSIS registered the Editor without the expected owned uninstaller: ${uninstaller}`)
      }
      const installRemoved = await waitForPathRemoval(installRoot)
      const registrations = await waitForEditorUnregistered()
      assert(installRemoved, `NSIS uninstall left its install directory: ${installRoot}`)
      assert(registrations.length === 0, `NSIS uninstall left registrations: ${registrations.join(', ')}`)
      cleanupSucceeded = true
      console.log(JSON.stringify({
        entry: 'editor-nsis-lifecycle',
        installer,
        isolatedInstallRoot: installRoot,
        uninstallRegistrationRemoved: true,
        installDirectoryRemoved: true,
      }))
    } catch (error) {
      cleanupFailure = error
    }
    if (cleanupSucceeded) rmSync(smokeRoot, { recursive: true, force: true })
    else console.error(`[RVB smoke] Retained failed NSIS evidence at ${smokeRoot}`)
    if (cleanupFailure) throw cleanupFailure
  }
}

const requested = process.argv.slice(2)
const selectedEntries = requested.length > 0
  ? requested
  : ['profile', 'server', 'client', 'editor']
const candidate = selectedEntries.some(entry => entry === 'profile' || entry === 'editor')
  ? loadContentCandidateFixture()
  : null
const sharedUserDataDir = selectedEntries.includes('profile')
  ? mkdtempSync(path.join(tmpdir(), 'rvb-red118-four-entry-user-'))
  : null
const entries = selectedEntries.includes('profile')
  ? ['profile', ...selectedEntries.filter(entry => entry !== 'profile')]
  : selectedEntries
let expectedIdentity = null
try {
  for (const entry of entries) {
    if (entry === 'server') await smokeServer(expectedIdentity, sharedUserDataDir)
    else if (entry === 'client') await smokeClient(expectedIdentity, sharedUserDataDir)
    else if (entry === 'profile') {
      expectedIdentity = await smokeProfileActivation(candidate, sharedUserDataDir)
    } else if (entry === 'editor') await smokeEditor(candidate)
    else throw new Error(`Unknown entry: ${entry}`)
  }
} finally {
  if (expectedIdentity && sharedUserDataDir) {
    await rollbackSharedCandidateToBase(expectedIdentity, sharedUserDataDir)
  }
  if (sharedUserDataDir) rmSync(sharedUserDataDir, { recursive: true, force: true })
}

process.exit(0)
