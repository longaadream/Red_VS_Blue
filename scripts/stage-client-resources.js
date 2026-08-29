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

function patchServerJsForSamePortUpgrade(filePath) {
  if (!fs.existsSync(filePath)) return
  let text = fs.readFileSync(filePath, 'utf-8')
  if (text.includes('__RVB_WS_SAME_PORT_UPGRADE__')) return

  const marker = "const path = require('path')"
  const patch = `// __RVB_WS_SAME_PORT_UPGRADE__
require('./ws-same-port-server.cjs')

const path = require('path')`

  if (!text.startsWith(marker)) {
    console.warn('[stage-client] server.js patch marker not found; same-port Upgrade preload not injected.')
    return
  }
  text = text.replace(marker, patch)
  fs.writeFileSync(filePath, text, 'utf-8')
  console.log('[stage-client] Patched server.js with same-port WebSocket Upgrade preload.')
}

// 直接落到 _client-stage 根下，不再多套 v0-game-menu-design/ 子目录。
// electron-builder 把 _client-stage 整体映射到 resources/app/standalone，所以
// 最终产物路径是 resources/app/standalone/server.js（扁平）。
// electron-client/main.ts 的 findServerEntry 既支持扁平也支持嵌套，无需改动。
fs.mkdirSync(dstRoot, { recursive: true })

console.log('[stage-client] Copying package.json and server.js...')
copyFile(path.join(standaloneDir, 'package.json'), path.join(dstRoot, 'package.json'))
copyFile(path.join(standaloneDir, 'server.js'), path.join(dstRoot, 'server.js'))
patchServerJsForSamePortUpgrade(path.join(dstRoot, 'server.js'))
copyFile(path.join(__dirname, 'ws-same-port-server.cjs'), path.join(dstRoot, 'ws-same-port-server.cjs'))

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

function copyRuntimeModule(moduleId) {
  const segments = moduleId.split('/')
  const source = path.join(__dirname, '..', 'node_modules', ...segments)
  const target = path.join(nmDst, ...segments)
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    console.error('[stage-client] ERROR: required runtime module missing:', moduleId)
    process.exit(1)
  }
  copyDir(source, target, [/\.tmp/])
}

// Next standalone tracing can omit instrumentation-only dependencies. Stage
// these explicitly so the packaged server cannot borrow them from the repo.
copyRuntimeModule('ws')
copyRuntimeModule('@prisma/client')
copyRuntimeModule('.prisma/client')

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
