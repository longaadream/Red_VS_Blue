// Local preview; the desktop-resource QA host serves the unchanged native assets on 8875.
import http from 'node:http'
http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    response.writeHead(302, { Location: '/adventure.html' }); response.end(); return
  }
  const upstream = http.get({ hostname: '127.0.0.1', port: 8875, path: request.url }, result => {
    response.writeHead(result.statusCode || 502, result.headers); result.pipe(response)
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('请先运行 node scripts/qa/practice-server.mjs 以提供桌面原生资源。')
  })
  request.on('aborted', () => upstream.destroy())
}).listen(8876, '127.0.0.1', () => console.log('Adventure preview: http://127.0.0.1:8876/'))
