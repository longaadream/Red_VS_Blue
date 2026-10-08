// Local candidate host: use the exact desktop resource payload and native pages.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = Number(process.env.PVE_ROUTE_QA_PORT || 8879)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid QA port')
const outfile = path.join(root, 'output/pve-fixed-route/qa-resources.cjs')
await build({
  stdin: {
    contents: "export { readClientProtocolBattleData } from './electron-client/client-protocol-resource'; export { getServerGameProfileIdentityV1 } from './lib/content-pipeline/runtime/profile-game-identity';",
    resolveDir: root,
    loader: 'ts',
  },
  outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
})
const api = createRequire(import.meta.url)(outfile)
const files = api.readClientProtocolBattleData({ htmlRoot: path.join(root, 'data/pages'), appRoot: root, activePackRoot: null, isPackaged: false })
const profile = api.getServerGameProfileIdentityV1()
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf' }
http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'pve-route.html'
    if (pathname === '__battle-data.json' || pathname === '__tutorial-profile.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(pathname === '__battle-data.json' ? { schemaVersion: 'rvb-client-battle-data/v1', files } : profile))
      return
    }
    if (pathname.split('/').some(part => part === '..' || part === '.') || pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid path')
    const candidates = [path.join(root, 'data/pages', pathname),
      ...(pathname.startsWith('data/') ? [path.join(root, pathname)] : []),
      ...(pathname.startsWith('images/') ? [path.join(root, 'public', pathname), path.join(root, 'public', pathname.slice(7))] : []),
    ]
    const target = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile())
    if (!target) { response.writeHead(404); response.end('Not found'); return }
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream')
    response.setHeader('Cache-Control', 'no-store')
    fs.createReadStream(target).pipe(response)
  } catch {
    response.writeHead(400); response.end('Invalid request')
  }
}).listen(port, '127.0.0.1', () => console.log('Fixed-route PVE candidate: http://127.0.0.1:' + port + '/'))
