const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const assert = require('node:assert/strict')

async function main() {
  const root = path.resolve(__dirname, '../..')
  const stage = process.env.RVB_SMOKE_STAGE || path.join(root, '_client-stage')
  const output = path.resolve(root, '../pr-tools/RED-202-IDE/binary-update-lean')
  fs.mkdirSync(output, { recursive: true })
  const guard = path.join(output, 'dependency-guard.cjs')
  fs.writeFileSync(guard, `const Module = require('node:module'), path = require('node:path');
const original = Module._resolveFilename;
Module._resolveFilename = function(...args) {
  const resolved = original.apply(this, args);
  if (path.isAbsolute(resolved)) {
    const relative = path.relative(process.env.RVB_SMOKE_STAGE, resolved);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Dependency escaped staged runtime: ' + resolved);
  }
  return resolved;
};`)
  const reservation = net.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  let logs = ''
  const child = spawn(path.join(root, '_client-node/node.exe'), ['--require', guard, path.join(stage, 'server.js')], {
    cwd: stage, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512', NODE_PATH: '', NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), RVB_SMOKE_STAGE: stage, USER_DATA_DIR: path.join(output, 'smoke-user-data') },
  })
  child.stdout.on('data', data => { logs += data })
  child.stderr.on('data', data => { logs += data })
  const closed = once(child, 'close')
  try {
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(logs)
      try { const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) }); ready = response.ok } catch {}
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(ready, logs)
    const results = []
    const routes = [['/', 200], ['/api/ping', 200], ['/qa/same-alignment', 404], ['/qa/client/index.html', 404]]
    for (const [route, status] of routes) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(15000) })
      const body = await response.text()
      assert.equal(response.status, status, `${route}: ${body.slice(0, 300)}\n${logs}`)
      assert.ok(body.length > 0)
      results.push({ route, status: response.status, bytes: Buffer.byteLength(body) })
      if (route === '/') {
        const assets = [...new Set([...body.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)[^"]*"/g)].map(match => match[1]))].slice(0, 3)
        assert.ok(assets.length > 0, 'No compiled page assets')
        routes.push(...assets.map(asset => [asset, 200]))
      }
    }
    assert.doesNotMatch(logs, /Dependency escaped staged runtime/)
    fs.writeFileSync(path.join(output, 'staged-smoke-results.json'), JSON.stringify({ stage, results }, null, 2))
    console.log(JSON.stringify(results))
  } finally {
    child.kill()
    await closed
    fs.writeFileSync(path.join(output, 'staged-smoke.log'), logs)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
