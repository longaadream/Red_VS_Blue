/** Local bundled-content preview; no remote profile or player persistence. */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { createGameProfileIdentityV1 } from '../lib/content-pipeline/runtime/profile-game-identity'
import { getBundledBaseProfileV1 } from '../lib/content-pipeline/runtime/bundled-base'
import { readClientProtocolBattleData } from '../electron-client/client-protocol-resource'

const root = resolve(__dirname, '..')
const port = Number(process.env.RVB_QA_PAGES_PORT || 38673)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port')
const identity = createGameProfileIdentityV1(getBundledBaseProfileV1(root).profile)
const battleData = JSON.stringify({
  schemaVersion: 'rvb-client-battle-data/v1',
  files: readClientProtocolBattleData({
    htmlRoot: resolve(root, 'data/pages'), appRoot: root, activePackRoot: null, isPackaged: false,
  }),
})
const replayStatePath = process.env.RVB_QA_REPLAY_STATE
let replayState: string | undefined
if (replayStatePath) {
  const outputRoot = resolve(root, 'output')
  const replayFile = resolve(root, replayStatePath)
  if (!replayFile.startsWith(outputRoot + sep) || extname(replayFile) !== '.json') {
    throw new Error('QA replay state must be a JSON fixture within this workspace output directory')
  }
  replayState = JSON.stringify(JSON.parse(readFileSync(replayFile, 'utf8')))
}
const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  response.setHeader('Cache-Control', 'no-store')
  if (pathname === '/__tutorial-qa-replay.json' && replayState !== undefined) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(replayState)
    return
  }
  if (pathname === '/__battle-data.json') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(battleData)
    return
  }
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
    { base: resolve(root, 'public'), relative },
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
