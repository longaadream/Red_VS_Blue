import fs from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outputDir = path.join(root, '_client-colyseus')
fs.rmSync(outputDir, { recursive: true, force: true })
fs.mkdirSync(outputDir, { recursive: true })

await build({
  entryPoints: [path.join(root, 'scripts', 'run-colyseus-server.mjs')],
  outfile: path.join(outputDir, 'colyseus-server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.json'),
  banner: {
    js: "import { createRequire as __rvbCreateRequire } from 'node:module'; const require = __rvbCreateRequire(import.meta.url);",
  },
})

const productBundle = fs.readFileSync(path.join(outputDir, 'colyseus-server.mjs'), 'utf8')
for (const forbidden of ['@prisma/client', 'new PrismaClient', 'PRAGMA ', 'initRoomStore', 'roomStore =']) {
  if (productBundle.includes(forbidden)) {
    throw new Error(`Colyseus product authority bundle contains forbidden legacy dependency: ${forbidden}`)
  }
}

console.log('[colyseus-build] Packaged product authority:', path.join(outputDir, 'colyseus-server.mjs'))
