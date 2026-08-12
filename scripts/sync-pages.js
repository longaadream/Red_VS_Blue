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
  console.log(`[sync-pages] Synced ${count} files: data/pages/ -> android-client/www/`)
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
