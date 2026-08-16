/**
 * sync-pages.js
 * Syncs data/pages/ -> android-client/www/
 * Run once:   node scripts/sync-pages.js
 * Watch mode: node scripts/sync-pages.js --watch
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'data', 'pages')
const DEST = path.join(ROOT, 'android-client', 'www')
const PUBLIC = path.join(ROOT, 'public')
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.svg', '.webp', '.gif'])

function checkEncoding() {
  require('./check-encoding')
}

function syncFile(relPath) {
  const src = path.join(SRC, relPath)
  const dest = path.join(DEST, relPath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  console.log(`[sync-pages] copied ${relPath}`)
}

function syncAll() {
  let count = 0

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        const rel = path.relative(SRC, full)
        syncFile(rel)
        count++
      }
    }
  }

  walk(SRC)
  let imageCount = 0
  function copyPublicImages(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        copyPublicImages(full)
      } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const rel = path.relative(PUBLIC, full)
        const dest = path.join(DEST, 'images', rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(full, dest)
        imageCount++
      }
    }
  }
  if (fs.existsSync(PUBLIC)) copyPublicImages(PUBLIC)
  console.log(`[sync-pages] Synced ${count} files: data/pages/ -> android-client/www/`)
  console.log(`[sync-pages] Synced ${imageCount} public images -> android-client/www/images/`)
}

const watchMode = process.argv.includes('--watch')

checkEncoding()
syncAll()

if (watchMode) {
  console.log('[sync-pages] Watching data/pages/ for changes...')
  fs.watch(SRC, { recursive: true }, (eventType, filename) => {
    if (!filename) return
    const rel = filename.replace(/\\/g, '/')
    const src = path.join(SRC, rel)
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) return
    checkEncoding()
    syncFile(rel)
  })
}
