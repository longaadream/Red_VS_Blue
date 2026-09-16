import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { androidArtifacts, verifyApkContents } from '../../scripts/android-release-artifacts.mjs'
import { sha256 } from '../../scripts/apk-delta.mjs'
const officialPublisher=JSON.parse(fs.readFileSync('config/content-script-publishers.json','utf8')).keyIds[0]
fs.mkdirSync(path.resolve('dist'),{recursive:true})
const dir=fs.mkdtempSync(path.resolve('dist/android-artifacts-test-'))
const base=path.join(dir,'base.apk'),target=path.join(dir,'target.apk'),bytes=crypto.randomBytes(400000)
fs.writeFileSync(base,bytes);fs.writeFileSync(target,Buffer.concat([bytes,Buffer.from('small update')]))
const inspect=apk=>({packageName:'com.redvsblue.client',versionCode:apk===base?20:21,versionName:'0.1.1',minSdk:24,signers:['a'.repeat(64)],debuggable:false})
test('first version publishes full APK without delta',()=>assert.equal(androidArtifacts(target,'v0.1.1',{inspect}).manifest.deltas.length,0))
test('compatible previous version adds beneficial delta',()=>{
  const r=androidArtifacts(target,'v0.1.1',{inspect,previousApk:base});assert.equal(r.manifest.deltas.length,1);assert.equal(r.assets.size,3)
})
test('different signer cannot create upgrade delta',()=>assert.throws(()=>androidArtifacts(target,'v0.1.1',{previousApk:base,inspect:apk=>({...inspect(apk),signers:[apk===base?'old':'new']})})))
test('same versionCode is not an upgrade',()=>assert.throws(()=>androidArtifacts(target,'v0.1.1',{previousApk:base,inspect:apk=>({...inspect(apk),versionCode:21})})))
const commit='c'.repeat(40)
function zipFixture(trustedPublisherKeyIds=[officialPublisher]) {
  const zip=new AdmZip(),files=[]
  function add(name,data){zip.addFile(name,Buffer.from(data));if(name.startsWith('assets/'))files.push({path:name,sha256:sha256(Buffer.from(data))})}
  add('assets/android-distribution.json',JSON.stringify({updateUrl:'https://github.com/longaadream/Red_VS_Blue/releases/latest/download/android-latest.json',trustedPublisherKeyIds}))
  for(const abi of ['arm64-v8a','x86_64']){add(`lib/${abi}/librvb_node.so`,'runtime');add(`assets/host-runtime/${abi}/cert.pem`,'cert')}
  add('classes.dex','Lcom/redvsblue/client/ApkDelta;')
  zip.addFile('assets/android-release-source.json',Buffer.from(JSON.stringify({sourceCommit:commit,files})))
  return zip
}
test('source receipt and required ABIs checked',()=>verifyApkContents(zipFixture(),commit))
test('stale source receipt refused',()=>assert.throws(()=>verifyApkContents(zipFixture(),'d'.repeat(40))))
test('modified source asset refused',()=>{const zip=zipFixture();zip.updateFile('assets/host-runtime/arm64-v8a/cert.pem',Buffer.from('stale'));assert.throws(()=>verifyApkContents(zip,commit))})
test('QA single ABI refused',()=>{const zip=zipFixture();zip.deleteFile('lib/arm64-v8a/librvb_node.so');assert.throws(()=>verifyApkContents(zip,commit),/ABI missing/)})
test('QA trust root refused',()=>{const zip=zipFixture();zip.addFile('res/raw/android_qa_ca.pem',Buffer.from('test'));assert.throws(()=>verifyApkContents(zip,commit))})
test('public APK without an official content publisher is refused',()=>assert.throws(()=>verifyApkContents(zipFixture([]),commit),/content publisher/))
