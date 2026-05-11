const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, 'lib', 'game', 'engine-browser-entry.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'GameEngine',
    external: ['fs', 'path', 'crypto', 'zlib', 'adm-zip'],
    minify: true,
    outfile: path.join(root, 'android-client', 'www', 'js', 'game-engine.js'),
  })
  console.log('[build-game-engine] Built android-client/www/js/game-engine.js')
}

main().catch((error) => {
  console.error('[build-game-engine] Failed:', error)
  process.exit(1)
})
