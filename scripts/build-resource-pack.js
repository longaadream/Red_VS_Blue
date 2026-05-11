/**
 * build-resource-pack.js
 *
 * Packages android-client/www/ into a distributable resource pack ZIP
 * and generates a sha256 manifest for server-side verification.
 *
 * Usage:
 *   node scripts/build-resource-pack.js [--name "v1.2"] [--desc "balance update"]
 *
 * Outputs:
 *   dist/resource-pack.zip              ← import this into the Android app
 *   public/resource-pack-manifest.json  ← served by GET /api/resource-pack
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const JSZip = require('jszip')

const ROOT = path.join(__dirname, '..')

// ── 先同步 data/ → android-client/www/data/ ──────────────────────────────────
// 确保 data/ 目录的最新改动都包含在资源包里
require('./sync-android-assets')
const WWW  = path.join(ROOT, 'android-client', 'www')
const DIST = path.join(ROOT, 'dist')
const OUT_ZIP      = path.join(DIST, 'resource-pack.zip')
const OUT_MANIFEST = path.join(ROOT, 'public', 'resource-pack-manifest.json')

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null
}
const packName    = getArg('--name')    || ('pack-' + new Date().toISOString().slice(0, 10))
const packVersion = getArg('--version') || new Date().toISOString().slice(0, 10).replace(/-/g, '')
const packDesc    = getArg('--desc')    || ''

// ── Files to exclude from the pack ───────────────────────────────────────────
// These are either auto-generated at runtime or contain device-specific data.
const EXCLUDE = new Set([
  'cordova.js',
  'cordova_plugins.js',
])
// Exclude subdirectory: cordova-related plugin dirs
const EXCLUDE_DIRS = new Set(['plugins'])

// ── Walk directory ────────────────────────────────────────────────────────────
function walk(dir, base) {
  const entries = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue
    const relPath = base ? base + '/' + entry.name : entry.name
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      entries.push(...walk(fullPath, relPath))
    } else {
      entries.push({ relPath, fullPath })
    }
  }
  return entries
}

// ── SHA-256 of a file ─────────────────────────────────────────────────────────
function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return 'sha256:' + hash.digest('hex')
}

// ── Auto-generate data manifests ─────────────────────────────────────────────
// Scans data/skills, data/cards, data/pieces, data/maps, data/rules inside WWW
// and writes a manifest.json listing IDs (filename without .json) for each dir.
function buildDataManifests() {
  const dataDirs = ['skills', 'cards', 'pieces', 'maps', 'rules']
  for (const sub of dataDirs) {
    const dir = path.join(WWW, 'data', sub)
    if (!fs.existsSync(dir)) continue
    const ids = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== 'manifest.json')
      .map(f => f.slice(0, -5))
      .sort()
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(ids, null, 2))
    console.log(`[build-pack] Generated data/${sub}/manifest.json (${ids.length} entries)`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DIST, { recursive: true })
  fs.mkdirSync(path.dirname(OUT_MANIFEST), { recursive: true })

  // Auto-generate data manifests before packaging
  buildDataManifests()

  const files = walk(WWW, '')
  console.log(`[build-pack] Found ${files.length} files in android-client/www/`)

  // Build manifest
  const manifestFiles = {}
  for (const { relPath, fullPath } of files) {
    manifestFiles['/' + relPath] = sha256(fullPath)
  }

  // Write pack.json meta
  const packMeta = {
    name: packName,
    version: packVersion,
    description: packDesc,
    builtAt: new Date().toISOString(),
    fileCount: files.length,
  }

  const manifest = {
    version: packVersion,
    name: packName,
    description: packDesc,
    builtAt: packMeta.builtAt,
    files: manifestFiles,
  }

  // Write manifest for server
  fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2))
  console.log(`[build-pack] Manifest written → ${OUT_MANIFEST}`)

  // Create ZIP using JSZip — always uses forward-slash paths regardless of platform
  const zip = new JSZip()

  // Add all www files
  for (const { relPath, fullPath } of files) {
    zip.file(relPath, fs.readFileSync(fullPath))
  }
  // Add pack.json
  zip.file('pack.json', JSON.stringify(packMeta, null, 2))

  // Write zip
  if (fs.existsSync(OUT_ZIP)) fs.unlinkSync(OUT_ZIP)
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  fs.writeFileSync(OUT_ZIP, zipBuffer)

  const zipStat = fs.statSync(OUT_ZIP)
  console.log(`[build-pack] ZIP written   → ${OUT_ZIP} (${(zipStat.size / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`[build-pack] Done. Pack name: ${packName}, version: ${packVersion}`)
  console.log()
  console.log('  To distribute:')
  console.log('    1. Share dist/resource-pack.zip with users')
  console.log('    2. Users import via 资源包管理 → 从本地文件选择')
  console.log()
  console.log('  For server verification:')
  console.log('    The manifest is at public/resource-pack-manifest.json')
  console.log('    It will be served by GET /api/resource-pack after next server build')
}

main().catch(e => { console.error(e); process.exit(1) })
