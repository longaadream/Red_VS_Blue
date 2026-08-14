/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * stage-client-resources.js
 *
 * 客户端打包前准备：复制必要的文件到临时目录 _client-stage
 * 只复制客户端需要的文件，避免打包不必要的 node_modules
 */
const fs = require('fs')
const path = require('path')

const srcRoot = path.join(__dirname, '..', '.next', 'standalone')
const dstRoot = path.join(__dirname, '..', '_client-stage')
const nodeDstRoot = path.join(__dirname, '..', '_client-node')

let standaloneDir = srcRoot
const packageJsonPath = path.join(srcRoot, 'package.json')
const serverJsPath = path.join(srcRoot, 'server.js')

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(serverJsPath)) {
  // Recursively find the directory containing both package.json and server.js
  // (needed for worktree builds where Next.js nests the output more deeply)
  function findStandaloneDir(dir, depth) {
    if (depth > 8) return null
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory() || e.name === 'node_modules') continue
        const candidate = path.join(dir, e.name)
        if (fs.existsSync(path.join(candidate, 'package.json')) &&
            fs.existsSync(path.join(candidate, 'server.js'))) {
          return candidate
        }
        const deeper = findStandaloneDir(candidate, depth + 1)
        if (deeper) return deeper
      }
    } catch {}
    return null
  }
  const found = findStandaloneDir(srcRoot, 0)
  if (found) {
    standaloneDir = found
    console.log('[stage-client] Using nested standalone directory:', path.relative(srcRoot, found))
  }
}

if (!fs.existsSync(path.join(standaloneDir, 'package.json'))) {
  console.error('[stage-client] ERROR: package.json not found. Run "npm run build" first.')
  process.exit(1)
}

if (fs.existsSync(dstRoot)) {
  console.log('[stage-client] Removing previous _client-stage...')
  fs.rmSync(dstRoot, { recursive: true, force: true })
}
if (fs.existsSync(nodeDstRoot)) {
  console.log('[stage-client] Removing previous _client-node...')
  fs.rmSync(nodeDstRoot, { recursive: true, force: true })
}

console.log('[stage-client] Creating staging directory...')

function copyDir(src, dst, excludePatterns = []) {
  fs.mkdirSync(dst, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    if (excludePatterns.some(p => entry.name.match(p))) continue
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isSymbolicLink()) {
      // Dereference symlinks to avoid absolute-path issues in packaged builds
      try {
        const realPath = fs.realpathSync(srcPath)
        const stat = fs.statSync(realPath)
        if (stat.isDirectory()) {
          copyDir(realPath, dstPath, excludePatterns)
        } else {
          fs.mkdirSync(path.dirname(dstPath), { recursive: true })
          fs.copyFileSync(realPath, dstPath)
        }
      } catch (e) {
        console.warn('[stage-client] Skipping broken symlink:', srcPath, e.message)
      }
    } else if (entry.isDirectory()) {
      copyDir(srcPath, dstPath, excludePatterns)
    } else {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function patchServerJsForWsProxy(filePath) {
  if (!fs.existsSync(filePath)) return
  let text = fs.readFileSync(filePath, 'utf-8')
  if (text.includes('__RVB_WS_SAME_PORT_PROXY__')) return

  const marker = "const path = require('path')"
  const patch = `const path = require('path')

// __RVB_WS_SAME_PORT_PROXY__
// Expose the internal WebSocket server through the same public HTTP port.
// NAT/frp users only need to publish the HTTP port; ws://host:port/ws/rooms/*
// is proxied to 127.0.0.1:WS_PORT inside the host process.
const net = require('net')
const http = require('http')
const __rvbOriginalCreateServer = http.createServer
function __rvbProxyWsUpgrade(req, socket, head) {
  const url = String((req && req.url) || '')
  if (!(url === '/ws' || url === '/ws/' || url.indexOf('/ws/rooms') === 0)) return false
  if (req.__rvbWsProxyHandled) return true
  req.__rvbWsProxyHandled = true
  const wsPort = parseInt(process.env.WS_PORT || '3001', 10)
  const target = net.connect(wsPort, '127.0.0.1')
  let settled = false
  target.on('connect', function() {
    settled = true
    const lines = [req.method + ' / HTTP/' + req.httpVersion]
    for (const i in req.rawHeaders) {
      if (Number(i) % 2 === 0) lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[Number(i) + 1])
    }
    target.write(lines.join('\\r\\n') + '\\r\\n\\r\\n')
    if (head && head.length) target.write(head)
    socket.pipe(target)
    target.pipe(socket)
  })
  target.on('error', function() {
    if (!settled) {
      try { socket.write('HTTP/1.1 502 Bad Gateway\\r\\nConnection: close\\r\\n\\r\\n') } catch {}
    }
    try { socket.destroy() } catch {}
  })
  socket.on('error', function() { try { target.destroy() } catch {} })
  return true
}
http.createServer = function rvbCreateServerWithWsProxy() {
  const server = __rvbOriginalCreateServer.apply(this, arguments)
  server.on('upgrade', function rvbDirectWsProxy(req, socket, head) {
    __rvbProxyWsUpgrade(req, socket, head)
  })
  const originalOn = server.on.bind(server)
  server.on = function rvbServerOn(eventName, listener) {
    if (eventName === 'upgrade' && typeof listener === 'function') {
      return originalOn(eventName, function rvbUpgradeRouter(req, socket, head) {
        if (__rvbProxyWsUpgrade(req, socket, head)) return
        return listener(req, socket, head)
      })
    }
    return originalOn(eventName, listener)
  }
  return server
}`

  if (!text.startsWith(marker)) {
    console.warn('[stage-client] server.js patch marker not found; WS same-port proxy not injected.')
    return
  }
  text = text.replace(marker, patch)
  fs.writeFileSync(filePath, text, 'utf-8')
  console.log('[stage-client] Patched server.js with same-port WebSocket proxy.')
}

// 直接落到 _client-stage 根下，不再多套 v0-game-menu-design/ 子目录。
// electron-builder 把 _client-stage 整体映射到 resources/app/standalone，所以
// 最终产物路径是 resources/app/standalone/server.js（扁平）。
// electron-client/main.ts 的 findServerEntry 既支持扁平也支持嵌套，无需改动。
fs.mkdirSync(dstRoot, { recursive: true })

console.log('[stage-client] Copying package.json and server.js...')
copyFile(path.join(standaloneDir, 'package.json'), path.join(dstRoot, 'package.json'))
copyFile(path.join(standaloneDir, 'server.js'), path.join(dstRoot, 'server.js'))
patchServerJsForWsProxy(path.join(dstRoot, 'server.js'))

console.log('[stage-client] Copying .next directory...')
const nextSrc = path.join(standaloneDir, '.next')
const nextDst = path.join(dstRoot, '.next')
if (fs.existsSync(nextSrc)) {
  copyDir(nextSrc, nextDst)
}

console.log('[stage-client] Copying node_modules (standalone trimmed set)...')
const nmSrc = path.join(standaloneDir, 'node_modules')
const nmDst = path.join(dstRoot, 'node_modules')
if (fs.existsSync(nmSrc)) {
  copyDir(nmSrc, nmDst, [/\.tmp/])
}

console.log('[stage-client] Copying public/static assets...')
const publicSrc = path.join(__dirname, '..', 'public')
const publicDst = path.join(dstRoot, 'public')
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, publicDst)
}

const staticSrc = path.join(__dirname, '..', '.next', 'static')
const staticDst = path.join(dstRoot, '.next', 'static')
if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
  copyDir(staticSrc, staticDst)
}

console.log('[stage-client] Copying Node runtime...')
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
copyFile(process.execPath, path.join(nodeDstRoot, nodeName))

console.log('[stage-client] Done.')
