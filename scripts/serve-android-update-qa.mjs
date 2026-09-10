import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
const root=path.resolve('dist/android-update-qa')
https.createServer({key:fs.readFileSync(path.join(root,'qa-key.pem')),cert:fs.readFileSync(path.join(root,'qa-cert.pem'))},(req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'https://localhost').pathname).slice(1)
  if(name==='redirect.zip'){res.writeHead(302,{Location:'http://10.0.2.2:19443/raster.zip'});res.end();return}
  if(name==='slow.apk'){
    const bytes=fs.readFileSync(path.join(root,'version7.apk'));let offset=0
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length})
    const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);res.end();return}res.write(bytes.subarray(offset,offset+32768));offset+=32768},80)
    req.on('close',()=>clearInterval(timer));return
  }
  if(!/^[a-zA-Z0-9_.-]+$/.test(name)||!['.apk','.zip','.json'].includes(path.extname(name))){res.writeHead(404);res.end();return}
  const file=path.join(root,name);if(!fs.existsSync(file)){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':name.endsWith('.json')?'application/json':'application/octet-stream','Content-Length':fs.statSync(file).size});fs.createReadStream(file).pipe(res)
}).listen(19443,'127.0.0.1',()=>console.log('Isolated HTTPS Android fixtures on 19443'))
