const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')

function createUpdateFeed(root, version = '0.1.4') {
  const requests = []
  const files = new Map()
  for (const v of ['0.1.1', '0.1.2', '0.1.3', '0.1.4']) {
    for (const suffix of ['.exe', '.exe.blockmap']) {
      const name = `RVB-Update-QA-${v}-Setup${suffix}`
      files.set('/' + name, path.join(root, v, name))
    }
  }
  const server = http.createServer(async (req, res) => {
    let filename
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
      if (pathname === '/__qa/status') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ service: 'rvb-binary-update-qa', version, requests })); return }
      filename = pathname === '/latest.yml' ? path.join(root, version, 'latest.yml') : files.get(pathname)
      if (!filename) { res.writeHead(404).end(); return }
      const size = fs.statSync(filename).size
      const ranges = req.headers.range ? req.headers.range.replace(/^bytes=/, '').split(',').map(r => {
        const match = /^(\d+)-(\d*)$/.exec(r.trim())
        if (!match) throw Error('Invalid range')
        const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) throw Error('Invalid range')
        return { start, end }
      }) : [{ start: 0, end: size - 1 }]
      const record = { path: pathname, range: req.headers.range || null, bytes: 0, status: req.headers.range ? 206 : 200 }
      requests.push(record)
      const boundary = 'rvb-qa-boundary'
      const partHeader = r => `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${r.start}-${r.end}/${size}\r\n\r\n`
      const multi = ranges.length > 1
      const length = ranges.reduce((total, r) => total + r.end - r.start + 1 + (multi ? Buffer.byteLength(partHeader(r)) + 2 : 0), 0) + (multi ? Buffer.byteLength(`--${boundary}--\r\n`) : 0)
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': length, 'Cache-Control': 'no-store', 'Content-Type': multi ? `multipart/byteranges; boundary=${boundary}` : 'application/octet-stream' }
      if (req.headers.range && !multi) headers['Content-Range'] = `bytes ${ranges[0].start}-${ranges[0].end}/${size}`
      res.writeHead(record.status, headers)
      if (req.method === 'HEAD') { res.end(); return }
      const write = async chunk => { record.bytes += Buffer.byteLength(chunk); if (!res.write(chunk)) await once(res, 'drain') }
      for (const range of ranges) {
        if (multi) await write(partHeader(range))
        for await (const chunk of fs.createReadStream(filename, range)) await write(chunk)
        if (multi) await write('\r\n')
      }
      res.end(multi ? `--${boundary}--\r\n` : undefined)
      if (multi) record.bytes += Buffer.byteLength(`--${boundary}--\r\n`)
    } catch (error) {
      if (!res.headersSent) res.writeHead(416).end('Invalid request')
      else res.destroy(error)
    }
  })
  return { server, requests, setVersion: next => { if (!['0.1.1', '0.1.2', '0.1.3', '0.1.4'].includes(next)) throw Error('Unknown version'); version = next } }
}
module.exports = { createUpdateFeed }
