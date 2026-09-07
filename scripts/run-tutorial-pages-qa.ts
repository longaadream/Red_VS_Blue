/** Local bundled-content preview; no remote profile or player persistence. */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { createGameProfileIdentityV1 } from '../lib/content-pipeline/runtime/profile-game-identity'
import { getBundledBaseProfileV1 } from '../lib/content-pipeline/runtime/bundled-base'

const root = resolve(__dirname, '..')
const port = Number(process.env.RVB_QA_PAGES_PORT || 38673)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port')
const identity = createGameProfileIdentityV1(getBundledBaseProfileV1(root).profile)
const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  response.setHeader('Cache-Control', 'no-store')
  if (pathname === '/__tutorial-profile.json') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(identity))
    return
  }
  let relative: string
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'tutorial.html' } catch {
    response.writeHead(400); response.end(); return
  }
  // Portrait URLs use /images/<file>, while bundled portraits live in public/.
  const portraitRelative = relative.startsWith('images/') ? relative.slice('images/'.length) : relative
  const candidates = relative.startsWith('data/') ? [{ base: root, relative }] : [
    { base: resolve(root, 'data/pages'), relative },
    { base: resolve(root, 'public'), relative: portraitRelative },
  ]
  const bases = candidates
  const file = bases.map(({ base, relative: path }) => ({ base, file: resolve(base, path) })).find(({ base, file }) =>
    file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile())?.file
  if (!file) { response.writeHead(404); response.end('Not found'); return }
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }
  response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
  createReadStream(file).pipe(response)
})
server.listen(port, '127.0.0.1', () => console.log(`Tutorial preview: http://127.0.0.1:${port}/tutorial.html`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close())
