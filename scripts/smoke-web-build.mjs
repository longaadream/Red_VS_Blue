import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const standalone = path.join(root, '.next', 'standalone')
assert.ok(fs.existsSync(path.join(standalone, 'server.js')), 'Run npm run build first: flat standalone/server.js is missing')

// Bind an ephemeral port so this check does not interrupt a developer's server.
const reservation = net.createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-web-smoke-'))
const child = spawn(process.execPath, [path.join(root, 'scripts', 'start-web.mjs')], {
  cwd: root,
  env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), APP_ROOT_DIR: root, USER_DATA_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let logs = ''
child.stdout.on('data', chunk => { logs += chunk })
child.stderr.on('data', chunk => { logs += chunk })
const exited = once(child, 'exit')
const origin = `http://127.0.0.1:${port}`
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(1000) })
      ready = response.ok && (await response.json()).name === 'RED vs BLUE Server'
    } catch { /* Startup is bounded below; failures include server logs. */ }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'Server did not become ready')
  const home = await fetch(origin, { signal: AbortSignal.timeout(10000) })
  assert.equal(home.status, 200)
  const html = await home.text()
  const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"\s]*\/_next\/static\/[^"\s]+)"/g)].map(match => match[1]))]
  assert.ok(assets.length > 0, 'Home page must reference generated Next assets')
  for (const asset of assets) {
    const response = await fetch(new URL(asset.replaceAll('&amp;', '&'), origin), { signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200, `Missing generated asset: ${asset}`)
    assert.ok((await response.arrayBuffer()).byteLength > 0)
  }
  const publicFile = fs.readdirSync(path.join(root, 'public'), { withFileTypes: true }).find(entry => entry.isFile())
  assert.ok(publicFile, 'Expected at least one public asset')
  const publicResponse = await fetch(`${origin}/${encodeURIComponent(publicFile.name)}`, { signal: AbortSignal.timeout(10000) })
  assert.equal(publicResponse.status, 200, 'Public assets must be served')
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), fs.readFileSync(path.join(root, 'public', publicFile.name)))
  for (const resource of ['pieces', 'maps', 'skills']) {
    const response = await fetch(`${origin}/api/${resource}`, { signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200, `Data API ${resource} must load from built source`)
    const body = await response.json()
    const catalog = body[resource]
    assert.ok(catalog && typeof catalog === 'object' && Object.keys(catalog).length > 0, `Empty ${resource} catalog`)
  }
  console.log(`[smoke-web] PASS: ping, home, ${assets.length} Next assets, public asset, pieces/maps/skills`)
} catch (error) {
  console.error(logs)
  throw error
} finally {
  if (child.exitCode === null) child.kill()
  await exited
  // Only this invocation's exact temporary directory is removed.
  fs.rmSync(runtime, { recursive: true, force: true })
}
