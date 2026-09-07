// Serve the checked-in pages without runtime skin substitutions.
// Optional sample=1 is injected only by this loopback QA server.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const repo = path.resolve(__dirname, '../../..'), pages = path.join(repo, 'data/pages')
const port = Number(process.env.RVB_SKIN_PORT || 4181)
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ttf':'font/ttf', '.txt':'text/plain' }
function within(base, relative) {
  const file = path.resolve(base, relative)
  if (!file.startsWith(base + path.sep)) throw Error('Invalid path')
  return file
}
http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), pathname = decodeURIComponent(url.pathname)
    let file
    if (pathname === '/') { res.writeHead(302, {Location:'/index.html'}).end(); return }
    if (pathname === '/qa/showcase.js') file = path.join(__dirname, 'showcase.js')
    else if (pathname.startsWith('/data/')) {
      if (!/^\/data\/(pieces|cards|skills|maps|rules|tiles|status-effects|tutorial)\//.test(pathname) && pathname !== '/data/skill-keywords.json') { res.writeHead(404).end(); return }
      file = within(path.join(repo, 'data'), pathname.slice(6))
    } else {
      file = within(pages, pathname.slice(1))
      if (!fs.existsSync(file) && pathname.startsWith('/images/')) file = within(path.join(repo, 'public'), pathname.slice(8))
    }
    if (!mime[path.extname(file)]) { res.writeHead(404).end(); return }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return }
      if (pathname === '/battle.html' && url.searchParams.get('mode') === 'training' && url.searchParams.get('sample') === '1')
        data = Buffer.from(data.toString().replace('</body>', '<script src="qa/showcase.js"></script></body>'))
      res.writeHead(200, {'Content-Type':mime[path.extname(file)], 'Cache-Control':'no-store'}).end(data)
    })
  } catch { res.writeHead(400).end() }
}).listen(port, '127.0.0.1', () => console.log('Checked-in pages: http://127.0.0.1:' + port))
