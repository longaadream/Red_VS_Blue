import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const pagesRoot = resolve(repositoryRoot, 'data', 'pages')
const dataRoot = resolve(repositoryRoot, 'data')
const publicRoot = resolve(repositoryRoot, 'public')
const port = positiveInteger(process.env.RVB_QA_PAGES_PORT, 38672)
const host = process.env.RVB_QA_PAGES_HOST?.trim() || '127.0.0.1'

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`)
  const pathname = decodeURIComponent(url.pathname)
  const candidate = resolveCandidate(pathname)
  if (!candidate || !existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': mimeType(candidate),
  })
  createReadStream(candidate).pipe(response)
})

server.listen(port, host, () => {
  console.log(`[colyseus-pages-qa] static client: http://${host}:${port}`)
  console.log('[colyseus-pages-qa] routes /data/* to game data and /images/* to public piece art')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

function resolveCandidate(pathname) {
  if (pathname === '/' || pathname === '') return resolve(pagesRoot, 'index.html')
  if (pathname.startsWith('/data/')) return safeResolve(dataRoot, pathname.slice('/data/'.length))
  if (pathname.startsWith('/images/')) return safeResolve(publicRoot, pathname.slice('/images/'.length))
  return safeResolve(pagesRoot, pathname.slice(1))
}

function safeResolve(root, relativePath) {
  const candidate = resolve(root, relativePath)
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null
}

function mimeType(filePath) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  })[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
