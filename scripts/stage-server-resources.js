/**
 * stage-server-resources.js
 *
 * electron-builder 默认使用 dot:false 的 glob，会跳过 .next/ 等隐藏目录。
 * 解决方案：打包前把 .next/standalone 复制到非隐藏目录 _standalone。
 * electron-builder 完成后由 cleanup-server-resources.js 清理。
 */
const fs = require('fs')
const path = require('path')

const srcRoot = path.join(__dirname, '..', '.next', 'standalone')
const dst = path.join(__dirname, '..', '_standalone')

// Turbopack creates nested directory based on package name: .next/standalone/v0-game-menu-design/
// Find the actual standalone directory that contains package.json and server.js
let src = srcRoot
const packageJsonPath = path.join(src, 'package.json')
const serverJsPath = path.join(src, 'server.js')

if (!fs.existsSync(packageJsonPath) || !fs.existsSync(serverJsPath)) {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  const nested = entries.find(e => e.isDirectory() &&
    e.name !== '_standalone' && // Prevent nesting
    fs.existsSync(path.join(src, e.name, 'package.json')) &&
    fs.existsSync(path.join(src, e.name, 'server.js')))
  if (nested) {
    src = path.join(src, nested.name)
    console.log('[stage] Using nested standalone directory:', nested.name)
  }
}

if (!fs.existsSync(path.join(src, 'package.json'))) {
  console.error('[stage] ERROR: package.json not found in .next/standalone. Run "npm run build" first.')
  process.exit(1)
}

if (fs.existsSync(dst)) {
  console.log('[stage] Removing previous _standalone...')
  fs.rmSync(dst, { recursive: true, force: true })
}

console.log('[stage] Copying .next/standalone → _standalone (this may take a moment)...')

// Custom copy function that skips _standalone and dereferences symlinks
function copyDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const dstPath = path.join(dstDir, entry.name)

    if (entry.name === '_standalone') continue

    if (entry.isSymbolicLink()) {
      // Dereference symlinks to avoid broken absolute paths in packaged builds
      try {
        const realPath = fs.realpathSync(srcPath)
        const stat = fs.statSync(realPath)
        if (stat.isDirectory()) {
          copyDir(realPath, dstPath)
        } else {
          fs.copyFileSync(realPath, dstPath)
        }
      } catch (e) {
        console.log(`[stage] Skipping broken symlink: ${entry.name}: ${e.message}`)
      }
    } else if (entry.isDirectory()) {
      copyDir(srcPath, dstPath)
    } else {
      try {
        fs.copyFileSync(srcPath, dstPath)
      } catch (e) {
        console.log(`[stage] Warning: Could not copy ${entry.name}: ${e.message}`)
      }
    }
  }
}

copyDir(src, dst)

// Next.js standalone does NOT include static assets — must copy manually
const staticSrc = path.join(__dirname, '..', '.next', 'static')
const staticDst = path.join(dst, '.next', 'static')
if (fs.existsSync(staticSrc)) {
  console.log('[stage] Copying .next/static → _standalone/.next/static...')
  fs.cpSync(staticSrc, staticDst, { recursive: true, dereference: true })
}

const publicSrc = path.join(__dirname, '..', 'public')
const publicDst = path.join(dst, 'public')
if (fs.existsSync(publicSrc)) {
  console.log('[stage] Copying public/ → _standalone/public...')
  fs.cpSync(publicSrc, publicDst, { recursive: true, dereference: true })
}

console.log('[stage] Done.')
