import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../output/official-site-preview')
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf'}
types['.svg']='image/svg+xml'
http.createServer((req,res)=>{
  try {
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname)
    const file=path.resolve(root,'.'+(name==='/'?'/index.html':name))
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return}
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream')
    res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res)
  } catch {res.writeHead(400);res.end('Bad request')}
}).listen(4188,'127.0.0.1',()=>console.log('Website preview: http://127.0.0.1:4188'))
