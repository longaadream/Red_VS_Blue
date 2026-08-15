import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const electronCandidates = [
  ...(process.env.RVB_ELECTRON_EXE ? [path.resolve(process.env.RVB_ELECTRON_EXE)] : []),
  path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(root, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe'),
]
const electronExecutable = electronCandidates.find(existsSync)
const mainEntry = path.join(root, 'electron-client', 'dist', 'main.js')
const smokeRoot = path.join(os.tmpdir(), `rvb-red46-electron-smoke-${process.pid}`)
const children = new Set()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

async function waitForTarget(port, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let observed = []
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`)
      observed = targets.map(({ title, type, url }) => ({ title, type, url }))
      const target = targets.find(predicate)
      if (target) return target
    } catch {}
    await delay(200)
  }
  throw new Error(`No matching renderer on debugging port ${port}: ${JSON.stringify(observed)}`)
}

async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  return {
    async evaluate(expression, timeoutMs = 30000) {
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
          params: { expression, awaitPromise: true, returnByValue: true },
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

async function evaluate(target, expression) {
  const connection = await connectTarget(target)
  try {
    return await connection.evaluate(expression)
  } finally {
    connection.close()
  }
}

async function evaluateFireAndForget(target, expression) {
  const connection = await connectTarget(target)
  connection.evaluateFireAndForget(expression)
  await delay(100)
  connection.close()
}

function launch({ port, profile = null, userDataRoot = smokeRoot }) {
  const args = [
    mainEntry,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataRoot}`,
  ]
  if (profile) args.push(`--rvb-dev-profile=${profile}`)
  const child = spawn(electronExecutable, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => process.stdout.write(`[electron:${port}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[electron:${port}] ${chunk}`))
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

async function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => null),
  ])
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return
  try {
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    })
  } catch {}
}

async function openGame(port) {
  const connectWindow = await waitForTarget(port, (target) => target.title === '连接服务器')
  const connection = await connectTarget(connectWindow)
  connection.evaluateFireAndForget("window.electronAPI.connectServer('http://127.0.0.1:3000')")
  await delay(100)
  connection.close()
  const gameTarget = await waitForTarget(port, (target) => target.url.startsWith('rvb-client://app/index.html'))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await evaluate(gameTarget, "typeof window.RvBIdentity?.ensureIdentity === 'function'")) return gameTarget
    } catch {}
    await delay(100)
  }
  throw new Error(`Identity runtime did not become ready on debugging port ${port}`)
}

async function readIdentity(target, displayName = null) {
  const expression = `(async () => {
      const identity = await window.RvBIdentity.ensureIdentity()
      ${displayName ? `
        document.getElementById('identityNameInput').value = ${JSON.stringify(displayName)}
        await window.saveIdentityName()
      ` : ''}
      const active = window.RvBIdentity.getIdentity()
      return {
        url: location.href,
        secureContext: window.isSecureContext,
        hasSubtleCrypto: !!window.crypto?.subtle,
        identity: active,
        storedIdentity: localStorage.getItem('rvb_identity_v2'),
        userName: document.getElementById('userName')?.textContent,
        serverUrl: window.RvBUtils.getServerUrl(),
      }
    })()`
  let lastError = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await evaluate(target, expression)
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError || new Error('Identity runtime did not stabilize')
}

async function waitForServerConfiguration(target, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    try {
      observed = await evaluate(target, `({
        active: window.RvBUtils?.getServerUrl() || '',
        mode: localStorage.getItem('rvb_lobby_server_mode'),
        current: localStorage.getItem('rvb_server_url'),
        remote: localStorage.getItem('rvb_remote_server_url')
      })`)
      if (observed.active) return observed
    } catch {}
    await delay(100)
  }
  throw new Error(`Shared server configuration did not appear: ${JSON.stringify(observed)}`)
}

async function readBuiltInPieceResources(target) {
  return evaluate(target, `(async () => {
    const manifestResponse = await fetch('./data/pieces/manifest.json')
    const manifest = manifestResponse.ok ? await manifestResponse.json() : []
    const pieces = []
    const imageStatuses = []
    for (const id of manifest) {
      const response = await fetch('./data/pieces/' + id + '.json')
      if (response.ok) {
        const piece = await response.json()
        pieces.push(piece)
        if (piece.image) {
          const imageResponse = await fetch('./images/' + piece.image)
          imageStatuses.push(imageResponse.status)
        }
      }
    }
    return {
      manifestStatus: manifestResponse.status,
      manifestCount: manifest.length,
      loadedCount: pieces.length,
      goodCount: pieces.filter((piece) => piece.faction === 'good').length,
      evilCount: pieces.filter((piece) => piece.faction === 'evil').length,
      imageCount: imageStatuses.length,
      loadedImageCount: imageStatuses.filter((status) => status === 200).length,
    }
  })()`)
}

async function verifyIdentityWriteFailures(target) {
  return evaluate(target, `(async () => {
    const storageKey = 'rvb_identity_v2'
    const originalRaw = localStorage.getItem(storageKey)
    const originalSetItem = Storage.prototype.setItem
    const result = {}
    try {
      localStorage.removeItem(storageKey)
      Storage.prototype.setItem = function () {
        throw new Error('simulated storage write failure')
      }
      await window.openIdentitySheet()
      result.initialize = {
        identity: window.RvBIdentity.getIdentity(),
        error: document.getElementById('identityError')?.textContent || '',
        errorVisible: document.getElementById('identityError')?.style.display !== 'none',
        userName: document.getElementById('userName')?.textContent || '',
      }

      Storage.prototype.setItem = originalSetItem
      if (originalRaw === null) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, originalRaw)
      window.closeIdentitySheet()
      window.clearIdentityError()
      window.refreshUserUI()

      const beforeSave = window.RvBIdentity.getIdentity()
      document.getElementById('identityNameInput').value = 'RED46 Should Not Persist'
      Storage.prototype.setItem = function () {
        throw new Error('simulated storage write failure')
      }
      await window.saveIdentityName()
      result.save = {
        before: beforeSave,
        after: window.RvBIdentity.getIdentity(),
        error: document.getElementById('identityError')?.textContent || '',
        errorVisible: document.getElementById('identityError')?.style.display !== 'none',
        userName: document.getElementById('userName')?.textContent || '',
      }
      return result
    } finally {
      Storage.prototype.setItem = originalSetItem
      if (originalRaw === null) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, originalRaw)
      window.closeIdentitySheet()
      window.clearIdentityError()
      window.refreshUserUI()
    }
  })()`)
}

assert(process.platform === 'win32', 'This smoke test requires Windows')
assert(electronExecutable, `Electron executable not found: ${electronCandidates.join(', ')}`)
assert(existsSync(mainEntry), `Compile the Electron client first: ${mainEntry}`)
mkdirSync(smokeRoot, { recursive: true })

let profileOne
let profileTwo
try {
  const first = launch({ port: 19341, profile: 'red46-smoke-one' })
  const firstTarget = await openGame(19341)
  profileOne = await readIdentity(firstTarget, 'RED46 Player One')
  const firstServer = await waitForServerConfiguration(firstTarget)
  const pieceResources = await readBuiltInPieceResources(firstTarget)
  assert(profileOne.secureContext, 'rvb-client:// is not a secure context')
  assert(profileOne.hasSubtleCrypto, 'window.crypto.subtle is unavailable')
  assert(profileOne.url.startsWith('rvb-client://app/index.html'), `First profile opened the wrong page: ${profileOne.url}`)
  assert(profileOne.identity?.displayName === 'RED46 Player One', `First profile name did not save: ${JSON.stringify(profileOne)}`)
  assert(profileOne.userName === 'RED46 Player One', `First profile UI did not refresh its name: ${JSON.stringify(profileOne)}`)
  assert(firstServer.active === 'http://127.0.0.1:3000', `First profile did not select the shared server: ${JSON.stringify(firstServer)}`)
  assert(pieceResources.manifestStatus === 200, `Development piece manifest was not served: ${JSON.stringify(pieceResources)}`)
  assert(pieceResources.manifestCount >= 16 && pieceResources.loadedCount === pieceResources.manifestCount,
    `Development piece resources were incomplete: ${JSON.stringify(pieceResources)}`)
  assert(pieceResources.goodCount >= 8 && pieceResources.evilCount >= 8,
    `Development piece resources did not provide both alignments: ${JSON.stringify(pieceResources)}`)
  assert(pieceResources.imageCount > 0 && pieceResources.loadedImageCount === pieceResources.imageCount,
    `Development piece images were incomplete: ${JSON.stringify(pieceResources)}`)

  const second = launch({ port: 19342, profile: 'red46-smoke-two' })
  const secondTarget = await openGame(19342)
  profileTwo = await readIdentity(secondTarget, 'RED46 Player Two')
  const secondServer = await waitForServerConfiguration(secondTarget)
  assert(profileTwo.secureContext && profileTwo.hasSubtleCrypto, 'Second profile lost the secure context')
  assert(profileTwo.identity?.displayName === 'RED46 Player Two', `Second profile name did not save: ${JSON.stringify(profileTwo)}`)
  assert(profileTwo.userName === 'RED46 Player Two', `Second profile UI did not refresh its name: ${JSON.stringify(profileTwo)}`)
  assert(secondServer.active === firstServer.active, 'Development profiles did not select the same Windows server')
  assert(profileTwo.identity?.id !== profileOne.identity?.id, 'Development profiles shared the same identity')
  assert(profileTwo.storedIdentity !== profileOne.storedIdentity, 'Development profiles shared localStorage')

  const duplicate = launch({ port: 19343, profile: 'red46-smoke-one' })
  const duplicateExitCode = await waitForExit(duplicate)
  assert(duplicateExitCode !== null, 'A second instance using the same development profile stayed running')
  assert(duplicateExitCode === 0, `The duplicate development profile exited unexpectedly: ${duplicateExitCode}`)
  assert(first.exitCode === null, 'The original development profile exited with its duplicate')
  assert(await evaluate(firstTarget, "document.readyState === 'complete'"), 'The original development profile stopped responding')

  await evaluateFireAndForget(firstTarget, 'window.close()')
  assert(await waitForExit(first) !== null, 'The first profile did not exit after its game window closed')
  const restarted = launch({ port: 19344, profile: 'red46-smoke-one' })
  const restartedTarget = await openGame(19344)
  const persisted = await readIdentity(restartedTarget)
  assert(persisted.identity?.id === profileOne.identity?.id, 'The profile identity changed after restart')
  assert(persisted.identity?.displayName === 'RED46 Player One', `The saved name did not persist: ${JSON.stringify(persisted)}`)
  const writeFailures = await verifyIdentityWriteFailures(restartedTarget)
  assert(writeFailures.initialize.identity === null, `Failed identity initialization appeared persisted: ${JSON.stringify(writeFailures)}`)
  assert(writeFailures.initialize.errorVisible && writeFailures.initialize.error, `Failed identity initialization was hidden: ${JSON.stringify(writeFailures)}`)
  assert(writeFailures.initialize.userName === '账号错误', `Failed identity initialization kept a success label: ${JSON.stringify(writeFailures)}`)
  assert(writeFailures.save.after?.displayName === writeFailures.save.before?.displayName, `Failed name save changed the persisted identity: ${JSON.stringify(writeFailures)}`)
  assert(writeFailures.save.after?.displayName !== 'RED46 Should Not Persist', `Failed name save appeared persisted: ${JSON.stringify(writeFailures)}`)
  assert(writeFailures.save.errorVisible && writeFailures.save.error, `Failed name save was hidden: ${JSON.stringify(writeFailures)}`)
  assert(writeFailures.save.userName === '账号错误', `Failed name save kept a success label: ${JSON.stringify(writeFailures)}`)

  const defaultRoot = path.join(smokeRoot, 'default-user-data')
  const defaultFirst = launch({ port: 19345, userDataRoot: defaultRoot })
  await waitForTarget(19345, (target) => target.title === '连接服务器')
  const defaultSecond = launch({ port: 19346, userDataRoot: defaultRoot })
  const defaultTarget = await waitForTarget(19345, (target) => target.type === 'page')
  const defaultSecondExitCode = await waitForExit(defaultSecond)
  assert(defaultSecondExitCode !== null, 'The default invocation no longer enforces a single instance')
  assert(defaultSecondExitCode === 0, `The duplicate default instance exited unexpectedly: ${defaultSecondExitCode}`)
  assert(defaultFirst.exitCode === null, 'The original default instance exited with its duplicate')
  assert(await evaluate(defaultTarget, "document.readyState === 'complete'"), 'The original default instance stopped responding')

  console.log(JSON.stringify({
    secureContext: profileOne.secureContext,
    hasSubtleCrypto: profileOne.hasSubtleCrypto,
    profileOne: profileOne.identity,
    profileTwo: profileTwo.identity,
    isolatedLocalStorage: true,
    sameProfileSingleInstance: true,
    defaultSingleInstance: true,
    identityPersistedAfterRestart: true,
    identityWriteFailuresVisible: true,
    pieceResources,
  }))

  stopProcessTree(second)
  stopProcessTree(restarted)
  stopProcessTree(defaultFirst)
} finally {
  for (const child of children) stopProcessTree(child)
  await delay(500)
  const resolvedSmokeRoot = path.resolve(smokeRoot)
  const resolvedTempRoot = path.resolve(os.tmpdir())
  assert(resolvedSmokeRoot.startsWith(`${resolvedTempRoot}${path.sep}`), `Refusing to clean unexpected smoke root: ${resolvedSmokeRoot}`)
  rmSync(resolvedSmokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}
