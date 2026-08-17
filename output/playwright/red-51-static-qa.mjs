import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const workspace = process.cwd()
const pageRoot = path.resolve(workspace, 'data/pages')
const dataRoot = path.resolve(workspace, 'data')
const publicRoot = path.resolve(workspace, 'public')
const port = 4175

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://127.0.0.1:${port}`).pathname)
  const segments = pathname.split('/').filter(Boolean)
  const servesData = segments[0] === 'data'
  const servesPublic = segments[0] === 'images'
  const root = servesData ? dataRoot : servesPublic ? publicRoot : pageRoot
  const relative = servesData || servesPublic ? segments.slice(1) : segments
  const target = path.resolve(root, ...(relative.length ? relative : ['index.html']))
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null
  return target
}

const server = http.createServer(async (request, response) => {
  const target = resolveRequestPath(request.url || '/')
  const contentType = target && contentTypes[path.extname(target).toLowerCase()]
  if (!target || !contentType) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('Not a file')
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': info.size,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(target).pipe(response)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`RED-51 static QA server: http://127.0.0.1:${port}`)
})
