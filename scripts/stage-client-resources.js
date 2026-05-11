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

let standaloneDir = srcRoot
const packageJsonPath = path.join(srcRoot, 'package.json')
const serverJsPath = path.join(srcRoot, 'server.js')

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(serverJsPath)) {
  const entries = fs.readdirSync(srcRoot, { withFileTypes: true })
  const nested = entries.find(e => e.isDirectory() &&
    fs.existsSync(path.join(srcRoot, e.name, 'package.json')) &&
    fs.existsSync(path.join(srcRoot, e.name, 'server.js')))
  if (nested) {
    standaloneDir = path.join(srcRoot, nested.name)
    console.log('[stage-client] Using nested standalone directory:', nested.name)
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

const v0Dir = path.join(dstRoot, 'v0-game-menu-design')
fs.mkdirSync(v0Dir, { recursive: true })

console.log('[stage-client] Copying package.json and server.js...')
copyFile(path.join(standaloneDir, 'package.json'), path.join(v0Dir, 'package.json'))
copyFile(path.join(standaloneDir, 'server.js'), path.join(v0Dir, 'server.js'))

console.log('[stage-client] Copying .next directory...')
const nextSrc = path.join(standaloneDir, '.next')
const nextDst = path.join(v0Dir, '.next')
if (fs.existsSync(nextSrc)) {
  copyDir(nextSrc, nextDst)
}

console.log('[stage-client] Copying Prisma client (excluding tmp files)...')
const prismaClient = path.join(standaloneDir, 'node_modules', '.prisma', 'client')
const prismaClientDst = path.join(v0Dir, 'node_modules', '.prisma', 'client')
if (fs.existsSync(prismaClient)) {
  copyDir(prismaClient, prismaClientDst, [/\.tmp/])
}

console.log('[stage-client] Copying public/static assets...')
const publicSrc = path.join(__dirname, '..', 'public')
const publicDst = path.join(v0Dir, 'public')
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, publicDst)
}

const staticSrc = path.join(__dirname, '..', '.next', 'static')
const staticDst = path.join(v0Dir, '.next', 'static')
if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
  copyDir(staticSrc, staticDst)
}

console.log('[stage-client] Done.')
