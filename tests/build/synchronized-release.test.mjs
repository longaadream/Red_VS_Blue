import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
import { verifyBundle, publishBundle } from '../../scripts/synchronized-release.mjs'
import { sha256 } from '../../scripts/apk-delta.mjs'

const commit='a'.repeat(40), signer='b'.repeat(64), version='0.1.2', tag='v'+version
fs.mkdirSync(path.resolve('dist'),{recursive:true})
function fixture() {
  const directory=fs.mkdtempSync(path.resolve('dist/sync-release-test-'))
  const exe=Buffer.from('Windows installer fixture'), apk=Buffer.from('Android package fixture')
  const exeName=`RED-vs-BLUE-${version}-Setup.exe`, apkName=`RED-vs-BLUE-${version}-Android.apk`
  const sha512=crypto.createHash('sha512').update(exe).digest('base64')
  const assets=new Map([[exeName,exe],[exeName+'.blockmap',Buffer.from('blockmap')],[apkName,apk]])
  assets.set('latest.yml',Buffer.from(yaml.dump({version,path:exeName,sha512,files:[{url:exeName,size:exe.length,sha512}]})))
  assets.set('android-latest.json',Buffer.from(JSON.stringify({schemaVersion:'rvb-android-update/v1',packageName:'com.redvsblue.client',versionName:version,versionCode:22,minSdk:24,debuggable:false,signers:[signer],size:apk.length,sha256:sha256(apk),url:`https://github.com/longaadream/Red_VS_Blue/releases/download/${tag}/${apkName}`,deltas:[]})))
  const record={schemaVersion:'rvb-client-release/v1',version,tag,sourceCommit:commit,androidVersionCode:22,androidSignerSha256:signer,assets:[]}
  function save() {
    record.assets=[...assets].map(([name,bytes])=>({name,size:bytes.length,sha256:sha256(bytes)}))
    for(const [name,bytes]of assets)fs.writeFileSync(path.join(directory,name),bytes)
    fs.writeFileSync(path.join(directory,'release-bundle.json'),JSON.stringify(record))
  }
  save(); return {directory,record,assets,save}
}
function github(f,{wrongTag=false,annotated=false,corruptRemote=false,failUpload=false}={}) {
  const calls=[]; let release,publicRelease=false
  const gh=args=>{
    calls.push(args)
    if(args[0]==='api') {
      const url=args.at(-1)
      if(url.endsWith('/commits/'+commit))return JSON.stringify({sha:commit})
      if(url.includes('matching-refs'))return JSON.stringify([{ref:'refs/tags/'+tag,object:{type:annotated?'tag':'commit',sha:annotated?'d'.repeat(40):wrongTag?'c'.repeat(40):commit}}])
      if(url.includes('/git/tags/'))return JSON.stringify({object:{type:'commit',sha:wrongTag?'c'.repeat(40):commit}})
      if(url.includes('?per_page'))return JSON.stringify([release?[release]:[]])
      if(url.endsWith('/latest'))return JSON.stringify({...release,draft:!publicRelease})
      return JSON.stringify(release)
    }
    if(args[1]==='create')release={id:123,tag_name:tag,target_commitish:commit,draft:true,prerelease:false,assets:[]}
    else if(args[1]==='upload') {
      if(failUpload)throw Error('upload failed')
      const bytes=fs.readFileSync(args[3])
      release.assets.push({name:path.basename(args[3]),size:bytes.length,digest:'sha256:'+(corruptRemote?'0'.repeat(64):sha256(bytes)),state:'uploaded'})
    } else if(args[1]==='edit')publicRelease=true
    return ''
  }
  return {gh,calls,get published(){return publicRelease}}
}
const verifyApk=()=>({versionCode:22,versionName:version})
test('complete bundle publishes only after both platforms are uploaded and checked',()=>{
  const f=fixture(),g=github(f,{annotated:true})
  assert.equal(publishBundle(f.directory,{gh:g.gh,verifyApk,publish:true}).published,true)
  assert.equal(g.calls.filter(a=>a[1]==='upload').length,6)
  assert.ok(g.published)
})
test('default upload leaves a verified draft',()=>{const f=fixture(),g=github(f);publishBundle(f.directory,{gh:g.gh,verifyApk});assert.equal(g.published,false)})
for(const options of [{wrongTag:true},{wrongTag:true,annotated:true},{corruptRemote:true},{failUpload:true}])test('refuse unsafe remote state '+JSON.stringify(options),()=>{
  const f=fixture(),g=github(f,options);assert.throws(()=>publishBundle(f.directory,{gh:g.gh,verifyApk,publish:true}));assert.equal(g.published,false)
})
test('missing Android artifact refuses before any network call',()=>{const f=fixture();f.assets.delete(`RED-vs-BLUE-${version}-Android.apk`);f.save();assert.throws(()=>verifyBundle(f.directory))})
test('changed local bytes refuse even when other platform is valid',()=>{const f=fixture();fs.appendFileSync(path.join(f.directory,'latest.yml'),'changed');assert.throws(()=>verifyBundle(f.directory))})
test('old Windows feed refuses even after receipt hashes recomputed',()=>{
  const f=fixture(),m=yaml.load(f.assets.get('latest.yml').toString());m.version='0.0.1';f.assets.set('latest.yml',Buffer.from(yaml.dump(m)));f.save();assert.throws(()=>verifyBundle(f.directory),/Windows/)
})
for(const change of [{versionName:'0.1.1'},{versionCode:-1},{signers:['wrong']},{schemaVersion:'other'},{minSdk:0},{deltas:[{format:'rvb-apk-copy-gzip/v1',fromVersionCode:20,baseSha256:'a'.repeat(64),size:10,sha256:'b'.repeat(64),url:'https://example.com/missing'}]}])test('bad Android metadata '+JSON.stringify(change),()=>{
  const f=fixture(),m=JSON.parse(f.assets.get('android-latest.json'));Object.assign(m,change);f.assets.set('android-latest.json',Buffer.from(JSON.stringify(m)));f.save();assert.throws(()=>verifyBundle(f.directory))
})
test('actual APK inspection failure blocks upload',()=>{const f=fixture(),g=github(f);assert.throws(()=>publishBundle(f.directory,{gh:g.gh,verifyApk:()=>{throw Error('APK signature/source proof invalid')},publish:true}));assert.equal(g.calls.length,0)})
