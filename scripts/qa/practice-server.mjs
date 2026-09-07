// Local-only browser QA surface, using the same resource payload as the desktop client.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outfile = path.join(root, 'output/pvp-practice/qa-resources.cjs')
await build({ stdin: { contents: `export { readClientProtocolBattleData } from './electron-client/client-protocol-resource'; export { getServerGameProfileIdentityV1 } from './lib/content-pipeline/runtime/profile-game-identity';`, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', banner: { js: '/* eslint-disable -- generated local QA resource adapter */' } })
const api = createRequire(import.meta.url)(outfile)
const files = api.readClientProtocolBattleData({ htmlRoot: path.join(root, 'data/pages'), appRoot: root, activePackRoot: null, isPackaged: false })
const profile = api.getServerGameProfileIdentityV1()
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf' }
http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html'
    if (pathname === '__battle-data.json' || pathname === '__tutorial-profile.json') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(pathname === '__battle-data.json' ? { schemaVersion: 'rvb-client-battle-data/v1', files } : profile)); return
    }
    if (pathname.split('/').some(part => part === '..') || pathname.includes('\\')) throw new Error('invalid path')
    const candidates = [path.join(root, 'data/pages', pathname),
      ...(pathname.startsWith('data/') ? [path.join(root, pathname)] : []),
      ...(pathname.startsWith('images/') ? [path.join(root, 'public', pathname.slice(7))] : [])]
    const target = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile())
    if (!target) { res.writeHead(404); res.end('Not found'); return }
    res.setHeader('Content-Type', contentTypes[path.extname(target)] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store'); fs.createReadStream(target).pipe(res)
  } catch { res.writeHead(400); res.end('Bad request') }
}).listen(8875, '127.0.0.1', () => console.log('PVP practice QA: http://127.0.0.1:8875/index.html'))
