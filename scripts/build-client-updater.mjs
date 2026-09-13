import { build } from 'esbuild'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const runtime = path.join(root, 'electron-client/update-runtime')
const requireRuntime = createRequire(path.join(runtime, 'package.json'))
const entry = requireRuntime.resolve('electron-updater/out/NsisUpdater.js')
await build({ entryPoints: [entry], outfile: path.join(root, 'electron-client/dist/update-runtime.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], legalComments: 'eof' })
const licenses = fs.readdirSync(path.join(runtime, 'node_modules'), { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith('.'))
  .flatMap(e => {
    const dir = path.join(runtime, 'node_modules', e.name)
    return fs.readdirSync(dir).filter(n => /^licen[sc]e/i.test(n)).map(n => `${e.name}\n${fs.readFileSync(path.join(dir, n), 'utf8')}`)
  })
fs.writeFileSync(path.join(root, 'electron-client/dist/update-runtime-LICENSES.txt'), licenses.join('\n\n'))
