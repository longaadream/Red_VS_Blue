import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const root = process.cwd()
const standaloneServer = path.join(root, '.next', 'standalone', 'server.js')
const functionsConfig = JSON.parse(
  await readFile(path.join(root, '.next', 'server', 'functions-config-manifest.json'), 'utf8'),
)

assert.equal(
  functionsConfig.functions?.['/_middleware']?.runtime,
  'nodejs',
  'the production Proxy must use the Node.js runtime',
)

const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    assert(address && typeof address === 'object')
    server.close((error) => {
      if (error) reject(error)
      else resolve(address.port)
    })
  })
})

const wrapper = String.raw`
  const readline = require('node:readline')
  delete process.env.RVB_PROFILE_ACTIVATION_ID
  delete process.env.RVB_PROFILE_ADMISSION_PAUSED
  require(process.argv[1])
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line === 'PAUSE') process.env.RVB_PROFILE_ADMISSION_PAUSED = 'next-process-probe'
    if (line === 'RESUME') delete process.env.RVB_PROFILE_ADMISSION_PAUSED
    process.stdout.write('RVB_GATE_ACK:' + line + '\n')
  })
`

const child = spawn(process.execPath, ['-e', wrapper, standaloneServer], {
  cwd: root,
  env: {
    ...process.env,
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let stdout = ''
let stderr = ''
const markers = new Set()
const markerWaiters = new Map()

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('RVB_GATE_ACK:')) continue
    markers.add(line)
    markerWaiters.get(line)?.()
  }
})
child.stderr.on('data', (chunk) => { stderr += chunk })

function waitForMarker(marker) {
  if (markers.has(marker)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}`)), 5_000)
    markerWaiters.set(marker, () => {
      clearTimeout(timer)
      markerWaiters.delete(marker)
      resolve()
    })
  })
}

async function command(name) {
  const marker = `RVB_GATE_ACK:${name}`
  const ack = waitForMarker(marker)
  child.stdin.write(`${name}\n`)
  await ack
}

async function fetchStatus(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
  return {
    status: response.status,
    body: await response.text(),
  }
}

async function waitForServer() {
  const deadline = Date.now() + 20_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`standalone Server exited ${child.exitCode}\n${stderr}\n${stdout}`)
    }
    try {
      const probe = await fetchStatus('/api/ping')
      if (probe.status === 200) return
      lastError = new Error(`ping returned ${probe.status}: ${probe.body}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw lastError ?? new Error('standalone Server did not start')
}

const evidence = {
  runtime: functionsConfig.functions['/_middleware'].runtime,
  before: undefined,
  paused: undefined,
  healthWhilePaused: undefined,
  resumed: undefined,
}

try {
  await waitForServer()
  evidence.before = await fetchStatus('/api/__profile-admission-probe__')
  assert.notEqual(evidence.before.status, 503)

  await command('PAUSE')
  evidence.paused = await fetchStatus('/api/__profile-admission-probe__')
  assert.equal(evidence.paused.status, 503)
  assert.equal(JSON.parse(evidence.paused.body).error, 'PROFILE_ACTIVATION_IN_PROGRESS')

  evidence.healthWhilePaused = await fetchStatus('/api/ping')
  assert.equal(evidence.healthWhilePaused.status, 200)

  await command('RESUME')
  evidence.resumed = await fetchStatus('/api/__profile-admission-probe__')
  assert.notEqual(evidence.resumed.status, 503)

  console.log(JSON.stringify({
    runtime: evidence.runtime,
    beforeStatus: evidence.before.status,
    pausedStatus: evidence.paused.status,
    pausedError: JSON.parse(evidence.paused.body).error,
    healthWhilePausedStatus: evidence.healthWhilePaused.status,
    resumedStatus: evidence.resumed.status,
  }, null, 2))
} finally {
  child.stdin.end()
  child.kill()
  await new Promise(resolve => {
    if (child.exitCode !== null) resolve()
    else child.once('exit', resolve)
    setTimeout(resolve, 5_000).unref()
  })
}
