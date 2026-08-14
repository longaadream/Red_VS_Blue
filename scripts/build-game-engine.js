const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const shimDir = path.join(root, 'mobile-server')

const browserResolvePlugin = {
  name: 'browser-game-resolve',
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/app-paths$/ }, () => ({ path: path.join(shimDir, 'app-paths-shim.ts') }))
    build.onResolve({ filter: /^@\/lib\/resource-pack$/ }, () => ({ path: path.join(shimDir, 'resource-pack-shim.ts') }))
    build.onResolve({ filter: /[/\\]app-paths$/ }, () => ({ path: path.join(shimDir, 'app-paths-shim.ts') }))
    build.onResolve({ filter: /^node:fs$/ }, () => ({ path: path.join(shimDir, 'fs-shim.ts') }))
    build.onResolve({ filter: /^node:path$/ }, () => ({ path: path.join(shimDir, 'path-shim.ts') }))
    build.onResolve({ filter: /^node:(?:crypto|zlib|os)$/ }, () => ({ path: path.join(shimDir, 'empty-shim.ts') }))
  },
}

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, 'lib', 'game', 'engine-browser-entry.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'GameEngine',
    external: ['fs', 'path', 'crypto', 'zlib', 'adm-zip'],
    plugins: [browserResolvePlugin],
    minify: true,
    outfile: path.join(root, 'android-client', 'www', 'js', 'game-engine.js'),
  })
  console.log('[build-game-engine] Built android-client/www/js/game-engine.js')
}

main().catch((error) => {
  console.error('[build-game-engine] Failed:', error)
  process.exit(1)
})
