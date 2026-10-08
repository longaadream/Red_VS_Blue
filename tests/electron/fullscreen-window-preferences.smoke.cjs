'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const WebSocket = require('ws')

const root = path.resolve(__dirname, '..', '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red241-fullscreen-smoke-'))
const profileName = 'red241-fullscreen'
const userDataRoot = path.join(profileRoot, 'dev-profiles', profileName)
const logPath = path.join(profileRoot, 'electron.log')

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function findFreePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

function readJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`))
          return
        }
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
  })
}

async function waitFor(description, operation, timeout = 45000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await operation()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function listTargets(port) {
  return readJson(`http://127.0.0.1:${port}/json/list`)
}

async function waitForPageTarget(port, previousTargetId = null) {
  return waitFor('Electron page target', async () => {
    const targets = await listTargets(port)
    return targets.find(target => (
      target.type === 'page'
      && target.webSocketDebuggerUrl
      && target.id !== previousTargetId
    ))
  })
}

class CdpSession {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl)
    this.nextId = 1
    this.pending = new Map()
    this.open = once(this.socket, 'open')
    this.socket.on('message', payload => {
      const message = JSON.parse(String(payload))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${message.error.message || 'CDP error'} (${message.error.code || 'unknown'})`))
      else pending.resolve(message.result)
    })
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  async send(method, params = {}) {
    await this.open
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
    }
    return result.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function connectTarget(target) {
  const session = new CdpSession(target.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  return session
}

async function waitForElectronApi(session) {
  return waitFor('trusted fullscreen bridge', async () => (
    await session.evaluate("typeof window.electronAPI?.getWindowFullscreen === 'function'")
  ) === true)
}

function startCandidate(port) {
  const output = fs.createWriteStream(logPath, { flags: 'a' })
  const child = spawn(electron, [
    'electron-client/dist/main.js',
    `--rvb-user-data-dir=${profileRoot}`,
    `--rvb-dev-profile=${profileName}`,
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  child.stdout.pipe(output)
  child.stderr.pipe(output)
  child.once('error', error => { output.write(`\n[smoke] process error: ${error.stack || error}\n`) })
  child.once('close', () => output.end())
  return child
}

function stopCandidate(child) {
  if (child.exitCode !== null || child.killed) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
}

async function openCandidate(port) {
  const child = startCandidate(port)
  const target = await waitForPageTarget(port)
  const session = await connectTarget(target)
  await waitFor('Electron protocol setup', async () => {
    const log = fs.readFileSync(logPath, 'utf8')
    return log.includes('[client] server.js not found')
      || log.includes('[client] Public server port:') && log.includes('[client] automatic local service startup failed:')
  })
  await waitFor('trusted game page navigation', async () => {
    const current = (await listTargets(port)).find(candidate => candidate.id === target.id)
    return current?.url?.startsWith('rvb-client://app/')
  })
  await waitForElectronApi(session)
  return { child, target, session }
}

async function closeTarget(session, targetId) {
  try { await session.send('Target.closeTarget', { targetId }) } catch {}
  session.close()
}

async function main() {
  assert.equal(fs.existsSync(electron), true, `Electron runtime missing: ${electron}`)
  let first
  let second
  let untrustedIpc = {
    status: 'not-run',
    reason: 'Electron CDP does not expose a second target in this runtime',
  }
  try {
    const firstPort = await findFreePort()
    first = await openCandidate(firstPort)
    const initialFullscreen = await first.session.evaluate('window.electronAPI.getWindowFullscreen()')
    assert.equal(initialFullscreen, true, `startup window state: ${initialFullscreen}`)

    assert.equal(await first.session.evaluate('window.electronAPI.setWindowFullscreen(false)'), false)
    const windowedFullscreen = await first.session.evaluate('window.electronAPI.getWindowFullscreen()')
    assert.equal(windowedFullscreen, false, `trusted setter did not leave fullscreen: ${windowedFullscreen}`)

    await first.session.evaluate(`window.__fullscreenEvents = []; window.electronAPI.onWindowFullscreenChanged(value => window.__fullscreenEvents.push(value))`)
    assert.equal(await first.session.evaluate('window.electronAPI.setWindowFullscreen(true)'), true)
    await waitFor('fullscreen change event', async () => (
      await first.session.evaluate('window.__fullscreenEvents.includes(true)')
    ))
    assert.equal(JSON.parse(fs.readFileSync(path.join(userDataRoot, 'rvb-window-preferences.json'), 'utf8')).fullscreen, true)

    assert.equal(await first.session.evaluate('window.electronAPI.setWindowFullscreen(false)'), false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(userDataRoot, 'rvb-window-preferences.json'), 'utf8')).fullscreen, false)

    try {
      const browserInfo = await readJson(`http://127.0.0.1:${firstPort}/json/version`)
      const browserSession = new CdpSession(browserInfo.webSocketDebuggerUrl)
      try {
        const untrustedTargetResult = await browserSession.send('Target.createTarget', { url: 'rvb-client://app/index.html?untrusted=1', newWindow: true })
        const untrustedTarget = await waitFor('untrusted target', async () => {
          const targets = await listTargets(firstPort)
          return targets.find(target => target.id === untrustedTargetResult.targetId && target.webSocketDebuggerUrl)
        })
        const untrustedSession = await connectTarget(untrustedTarget)
        await waitForElectronApi(untrustedSession)
        const rejection = await untrustedSession.evaluate("(async()=>{try{await window.electronAPI.getWindowFullscreen();return {accepted:true}}catch(error){return {accepted:false,message:String(error?.message||error)}}})()")
        assert.equal(rejection.accepted, false, `untrusted sender unexpectedly accepted: ${JSON.stringify(rejection)}`)
        assert.match(rejection.message, /trusted window set|sender outside/i)
        untrustedIpc = { status: 'rejected', message: rejection.message }
        await closeTarget(untrustedSession, untrustedTarget.id)
      } finally {
        browserSession.close()
      }
    } catch (error) {
      if (!/Not supported/i.test(String(error?.message ?? error))) throw error
      untrustedIpc = {
        status: 'not-run',
        reason: 'Electron 43 CDP Target.createTarget returned Not supported; ipc-trust.test.ts covers rejection paths',
      }
    }

    stopCandidate(first.child)
    await once(first.child, 'close').catch(() => {})
    first.session.close()
    first = null

    const secondPort = await findFreePort()
    second = await openCandidate(secondPort)
    const persistedFullscreen = await second.session.evaluate('window.electronAPI.getWindowFullscreen()')
    assert.equal(persistedFullscreen, false, `restart ignored persisted state: ${persistedFullscreen}`)

    console.log(JSON.stringify({
      ok: true,
      profileRoot,
      userDataRoot,
      logPath,
      startupFullscreen: initialFullscreen,
      afterTrustedSetFullscreen: windowedFullscreen,
      afterTrustedToggleFullscreen: true,
      afterRestartFullscreen: persistedFullscreen,
      untrustedIpc,
    }, null, 2))
  } finally {
    if (second) {
      await closeTarget(second.session, second.target.id)
      stopCandidate(second.child)
    }
    if (first) {
      await closeTarget(first.session, first.target.id)
      stopCandidate(first.child)
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, profileRoot, logPath, error: error.stack || String(error) }, null, 2))
  process.exitCode = 1
})
