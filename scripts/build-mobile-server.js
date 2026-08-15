/**
 * build-mobile-server.js
 *
 * Bundles mobile-server/mobile-server-entry.ts into a single browser-compatible
 * IIFE that the Android GameEngineWebView loads.
 */

const path  = require('path')
const fs    = require('fs')
const esbuild = require('esbuild')

const root    = path.join(__dirname, '..')
const dataDir = path.join(root, 'data')
const shimDir = path.join(root, 'mobile-server')
const outFile = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'mobile-server.js')

// ── Load all JSON files from a data sub-directory ─────────────────────────────

function loadDir(subDir) {
  const dir = path.join(dataDir, subDir)
  const result = {}
  if (!fs.existsSync(dir)) return result
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      const key = obj.id || file.replace('.json', '')
      result[key] = obj
    } catch {}
  }
  return result
}

// ── All-in-one resolve plugin ─────────────────────────────────────────────────
//
// Handles:
//  • 'fs' / 'path'            → mobile-server shims
//  • '@/lib/app-paths'        → app-paths-shim
//  • '@/lib/resource-pack'    → resource-pack-shim
//  • '@/lib/db'               → db-shim
//  • '@/config/maps'          → project config/maps.ts (real, no typeof-window)
//  • '@/...'                  → project root relative resolution
//  • '*/file-loader'          → file-loader-shim
//  • '*/piece-repository'     → piece-repository-shim
//  • '*/skill-repository'     → skill-repository-shim

const resolvePlugin = {
  name: 'mobile-resolve',
  setup(build) {

    // ── Bare Node.js built-ins ─────────────────────────────────────────────
    build.onResolve({ filter: /^(?:node:)?fs$/ },   () => ({ path: shimDir + '/fs-shim.ts' }))
    build.onResolve({ filter: /^(?:node:)?path$/ }, () => ({ path: shimDir + '/path-shim.ts' }))
    build.onResolve({ filter: /^(?:node:)?os$/ },   () => ({ path: shimDir + '/os-shim.ts' }))
    build.onResolve({ filter: /^(?:node:)?(zlib|crypto|stream|net|http|https|child_process|worker_threads)$/ }, () => ({
      path: shimDir + '/empty-shim.ts'
    }))

    // ── @/ path aliases ────────────────────────────────────────────────────
    build.onResolve({ filter: /^@\// }, args => {
      const rel = args.path.slice(2)  // strip '@/'

      // Specific shims for modules with typeof-window guards
      if (rel === 'lib/app-paths')     return { path: shimDir + '/app-paths-shim.ts' }
      if (rel === 'lib/resource-pack') return { path: shimDir + '/resource-pack-shim.ts' }
      if (rel === 'lib/db')            return { path: shimDir + '/db-shim.ts' }

      // Generic: try common TypeScript extensions before falling back
      const candidates = [
        root + '/' + rel + '.ts',
        root + '/' + rel + '.tsx',
        root + '/' + rel + '/index.ts',
        root + '/' + rel,
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return { path: c }
      }
      return { path: root + '/' + rel }
    })

    // ── lib/game module shims ──────────────────────────────────────────────
    const moduleShims = [
      ['app-paths',        shimDir + '/app-paths-shim.ts'],
      ['file-loader',       shimDir + '/file-loader-shim.ts'],
      ['piece-repository',  shimDir + '/piece-repository-shim.ts'],
      ['skill-repository',  shimDir + '/skill-repository-shim.ts'],
    ]
    const modulePattern = new RegExp('[/\\\\](' + moduleShims.map(([n]) => n).join('|') + ')$')

    build.onResolve({ filter: modulePattern }, args => {
      for (const [name, shimPath] of moduleShims) {
        if (args.path.replace(/\\/g, '/').endsWith('/' + name)) {
          return { path: shimPath }
        }
      }
    })
  },
}

// ── Post-build: prepend __GAME_DATA__ ─────────────────────────────────────────

const gameDataPlugin = {
  name: 'game-data',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length || !fs.existsSync(outFile)) return

      const gameData = {
        skills:        loadDir('skills'),
        pieces:        loadDir('pieces'),
        maps:          loadDir('maps'),
        cards:         loadDir('cards'),
        rules:         loadDir('rules'),
        effects:       loadDir('effects'),
        tiles:         loadDir('tiles'),
        statusEffects: loadDir('status-effects'),
      }

      const preamble = `var __GAME_DATA__ = ${JSON.stringify(gameData)};\n`
      fs.writeFileSync(outFile, preamble + fs.readFileSync(outFile, 'utf-8'))

      const stats = Object.entries(gameData)
        .map(([k, v]) => `${k}:${Object.keys(v).length}`)
        .join(' ')
      console.log(`[build-mobile-server] __GAME_DATA__ — ${stats}`)
    })
  },
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  // Create empty shims for Node built-ins we don't need
  const emptyShim = shimDir + '/empty-shim.ts'
  if (!fs.existsSync(emptyShim)) {
    fs.writeFileSync(emptyShim, 'export default {}\n')
  }
  const osShim = shimDir + '/os-shim.ts'
  if (!fs.existsSync(osShim)) {
    fs.writeFileSync(osShim, 'export default { networkInterfaces: () => ({}) }\n')
  }

  await esbuild.build({
    entryPoints: [shimDir + '/mobile-server-entry.ts'],
    bundle:      true,
    platform:    'browser',
    format:      'iife',
    globalName:  '_rvbMobileServer',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.MOBILE_SERVER': '"true"',
    },
    plugins:  [resolvePlugin, gameDataPlugin],
    outfile:  outFile,
    banner: {
      js: "var process = globalThis.process || { env: { NODE_ENV: 'production', MOBILE_SERVER: 'true' }, cwd: function () { return '.' } }; if (!globalThis.structuredClone) globalThis.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); }; if (globalThis.console) { console.log = function () {}; console.info = function () {}; console.debug = function () {}; }",
    },
    logLevel: 'warning',
    minify:   false,
  })

  const kb = Math.round(fs.statSync(outFile).size / 1024)
  console.log(`[build-mobile-server] Done → ${path.relative(root, outFile)} (${kb} KB)`)
}

main().catch(err => {
  console.error('[build-mobile-server] Failed:', err.message || err)
  process.exit(1)
})
