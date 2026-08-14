/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node build script */
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')

async function main() {
  const options = {
    entryPoints: [path.join(root, 'lib', 'game', 'engine-browser-entry.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'GameEngine',
    external: [
      'fs', 'path', 'crypto', 'zlib', 'adm-zip',
      'node:fs', 'node:path', 'node:crypto', 'node:zlib',
    ],
    minify: true,
  }
  const outputs = [
    path.join(root, 'data', 'pages', 'js', 'game-engine.js'),
    path.join(root, 'android-client', 'www', 'js', 'game-engine.js'),
  ]
  for (const outfile of outputs) {
    await esbuild.build({ ...options, outfile })
    console.log(`[build-game-engine] Built ${path.relative(root, outfile)}`)
  }
}

main().catch((error) => {
  console.error('[build-game-engine] Failed:', error)
  process.exit(1)
})
