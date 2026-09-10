import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
const root = path.resolve(import.meta.dirname, '..')
const runtimeLock=JSON.parse(fs.readFileSync(path.join(root,'config/android-runtime.lock.json'),'utf8'))
const out = path.join(root, 'android/app/build/generated/android-host-assets/host-code')
fs.mkdirSync(out, { recursive: true })
for(const name of ['server.cjs','sqlite-worker.cjs'])fs.rmSync(path.join(out,name),{force:true})
for (const [entry, name] of [['android-host-entry.ts', 'server.mjs'], ['sqlite-authority-worker.ts', 'sqlite-worker.mjs']]) {
  await build({ entryPoints: [path.join(root, 'mobile-server', entry)], outfile: path.join(out, name), bundle: true, platform: 'node', format: 'esm', target: 'node24', alias:{colyseus:'@colyseus/core'}, banner:{js:"import {createRequire as __rvbCreateRequire} from 'node:module'; const require=__rvbCreateRequire(import.meta.url);"}, logLevel: 'warning', tsconfig: path.join(root, 'tsconfig.json') })
}
console.log('Built Android Colyseus authority and SQLite worker')
fs.cpSync(path.join(root,'config/android-runtime-licenses'),path.join(path.dirname(out),'host-licenses/llvm'),{recursive:true})

// ELF dependency discovery keeps only the libraries actually linked by Node.
function needed(bytes) {
  if(bytes.readUInt32BE(0)!==0x7f454c46||bytes[4]!==2||bytes[5]!==1)throw Error('Expected little-endian ELF64')
  const offset=Number(bytes.readBigUInt64LE(32)), size=bytes.readUInt16LE(54), count=bytes.readUInt16LE(56), segments=[]
  for(let i=0;i<count;i++){const p=offset+i*size;segments.push({type:bytes.readUInt32LE(p),offset:Number(bytes.readBigUInt64LE(p+8)),address:Number(bytes.readBigUInt64LE(p+16)),size:Number(bytes.readBigUInt64LE(p+32)),align:Number(bytes.readBigUInt64LE(p+48))})}
  const dynamic=segments.find(s=>s.type===2), tags=[]
  for(let p=dynamic.offset;p<dynamic.offset+dynamic.size;p+=16){const type=Number(bytes.readBigUInt64LE(p));if(!type)break;tags.push({type,value:Number(bytes.readBigUInt64LE(p+8))})}
  const strings=tags.find(t=>t.type===5).value, segment=segments.find(s=>s.type===1&&s.address<=strings&&strings<s.address+s.size)
  const start=segment.offset+strings-segment.address
  return { names:tags.filter(t=>t.type===1).map(t=>{const p=start+t.value;return bytes.subarray(p,bytes.indexOf(0,p)).toString()}),segments }
}
const assets=path.dirname(out), jni=path.join(root,'android/app/build/generated/android-host-jni')
for(const [arch,abi] of [['x86_64','x86_64'],['aarch64','arm64-v8a']]) {
  if(process.env.RVB_ANDROID_HOST_ABI && process.env.RVB_ANDROID_HOST_ABI!==abi)continue
  const source=path.join(root,'dist/android-runtime-qa',arch), visited=new Set()
  function verified(relative){
    const bytes=fs.readFileSync(path.join(source,relative))
    if(createHash('sha256').update(bytes).digest('hex')!==runtimeLock.architectures[arch].files[relative])throw Error('Android runtime hash mismatch; rerun prepare-android-runtime.py: '+relative)
    return bytes
  }
  function copyElf(name,isNode=false) {
    if(visited.has(name))return;visited.add(name)
    const bytes=verified((isNode?'bin/':'lib/')+name), elf=needed(bytes)
    if(abi==='arm64-v8a'&&elf.segments.some(s=>s.type===1&&s.align<16384))throw Error('Android ARM64 runtime is not 16KB aligned: '+name)
    const dest=isNode?path.join(jni,abi,'librvb_node.so'):path.join(assets,'host-runtime',abi,'lib',name)
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes)
    for(const dependency of elf.names)if(!['libc.so','libm.so','libdl.so','liblog.so','libandroid.so'].includes(dependency))copyElf(dependency)
  }
  copyElf('node',true)
  fs.writeFileSync(path.join(assets,'host-runtime',abi,'cert.pem'),verified('etc/tls/cert.pem'))
  for(const relative of Object.keys(runtimeLock.architectures[arch].files).filter(p=>p.startsWith('share/doc/')&&/\/(LICENSE|copyright)$/.test(p))){
    const target=path.join(assets,'host-licenses',relative.slice('share/doc/'.length));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,verified(relative))
  }
}
export function writeHostManifest(){
  const files=[]
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name!=='host-files.json'){const bytes=fs.readFileSync(file);files.push({path:path.relative(assets,file).split(path.sep).join('/'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}}}
  walk(assets);fs.writeFileSync(path.join(assets,'host-files.json'),JSON.stringify({files}))
}
