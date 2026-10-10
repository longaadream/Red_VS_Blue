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
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red250-exit-smoke-'))
const profileName = 'red250-exit'
const logPath = path.join(profileRoot, 'electron.log')
const screenshotPath = path.join(profileRoot, 'main-menu-before-exit.png')

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

async function waitFor(description, operation, timeout = 60000) {
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

async function waitForPageTarget(port) {
  return waitFor('Electron page target', async () => {
    const targets = await listTargets(port)
    return targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
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
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
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

function startCandidate(port) {
  const output = fs.createWriteStream(logPath, { flags: 'a' })
  const child = spawn(electron, [
    'electron-client/dist/main.js',
    `--rvb-user-data-dir=${profileRoot}`,
    `--rvb-dev-profile=${profileName}`,
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.pipe(output)
  child.stderr.pipe(output)
  child.once('error', error => { output.write(`\n[smoke] process error: ${error.stack || error}\n`) })
  child.once('close', () => output.end())
  return child
}

function stopCandidate(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
}

async function main() {
  assert.equal(fs.existsSync(electron), true, `Electron runtime missing: ${electron}`)
  let child
  let session
  try {
    const port = await findFreePort()
    child = startCandidate(port)
    const target = await waitForPageTarget(port)
    session = new CdpSession(target.webSocketDebuggerUrl)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await waitFor('trusted game menu', async () => {
      const state = await session.evaluate(`(() => {
        const button = document.querySelector('[data-application-exit]')
        return { url: location.href, ready: document.readyState, hidden: button?.hidden ?? true,
          api: typeof window.electronAPI?.requestApplicationExit === 'function' }
      })()`)
      return state.url.startsWith('rvb-client://app/index.html') && state.ready === 'complete' && state.api && !state.hidden
    })

    const screenshot = await session.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    const beforeClick = await session.evaluate(`(() => {
      const button = document.querySelector('[data-application-exit]')
      const rect = button?.getBoundingClientRect()
      const x = rect ? rect.left + rect.width / 2 : 0
      const y = rect ? rect.top + rect.height / 2 : 0
      const hit = rect ? document.elementFromPoint(x, y) : null
      return {
        text: button?.textContent?.trim(),
        disabled: button?.disabled,
        hidden: button?.hidden,
        x,
        y,
        hitIsButton: hit === button || hit?.closest?.('[data-application-exit]') === button,
      }
    })()`)
    assert.equal(beforeClick.text, '退出程序')
    assert.equal(beforeClick.disabled, false)
    assert.equal(beforeClick.hidden, false)
    assert.equal(beforeClick.hitIsButton, true, 'exit button is not the hit-tested element at its visible center')

    const closed = once(child, 'close')
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: beforeClick.x,
      y: beforeClick.y,
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: beforeClick.x,
      y: beforeClick.y,
      button: 'left',
      clickCount: 1,
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: beforeClick.x,
      y: beforeClick.y,
      button: 'left',
      clickCount: 1,
    })
    const [code, signal] = await Promise.race([
      closed,
      delay(30000).then(() => { throw new Error('Electron did not close after the exit button request') }),
    ])
    assert.equal(signal, null, `Electron exited from a signal: ${signal}`)
    assert.equal(code, 0, `Electron exited with code ${code}`)
    console.log(JSON.stringify({ ok: true, profileRoot, logPath, screenshotPath, exitCode: code }, null, 2))
  } finally {
    if (session) session.close()
    if (child) stopCandidate(child)
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, profileRoot, logPath, screenshotPath, error: error.stack || String(error) }, null, 2))
  process.exitCode = 1
})
