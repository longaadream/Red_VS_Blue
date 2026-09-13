import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createApkDelta, sha256 } from '../../scripts/apk-delta.mjs'

const root = path.resolve(import.meta.dirname, '../..')
fs.mkdirSync(path.join(root,'dist'),{recursive:true})
const out = fs.mkdtempSync(path.join(root, 'dist/apk-delta-tests-'))
const javaRoot = process.env.JAVA_HOME || 'C:/Program Files/Android/Android Studio/jbr'
const executable = name => path.join(javaRoot, 'bin', name + (process.platform === 'win32' ? '.exe' : ''))
const options = { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
let base, target, patch
before(() => {
  const directory = 'android/app/src/uiAcceptance/java/com/redvsblue/client/'
  execFileSync(executable('javac'), ['-d', out, directory+'ApkDelta.java', directory+'ApkUpdateTransfer.java', 'tests/build/ApkDeltaHarness.java'], { ...options, cwd: root })
  // Incompressible unchanged bytes + insertion/edits model signed APK offsets moving.
  base = crypto.randomBytes(4 * 1024 * 1024)
  target = Buffer.concat([base.subarray(0, 17000), crypto.randomBytes(111), base.subarray(17000, 700000), crypto.randomBytes(5000), base.subarray(705000)])
  patch = createApkDelta(base, target).patch
  fs.writeFileSync(path.join(out, 'base.apk'), base); fs.writeFileSync(path.join(out, 'target.apk'), target); fs.writeFileSync(path.join(out, 'patch'), patch)
})
function run(mode, file='patch', hash) {
  const destination = path.join(out, `${mode}-${crypto.randomUUID()}`)
  const args=[mode,path.join(out,'base.apk'),path.join(out,file),path.join(out,'target.apk'),destination]
  if(hash)args.push(hash)
  return { destination, output: execFileSync(executable('java'), ['-cp',out,'com.redvsblue.client.ApkDeltaHarness',...args],options).trim() }
}
test('offset shifts reuse bytes and reconstruct byte-exact target in Java', () => {
  assert.ok(patch.length < target.length * 0.1)
  const result=run('apply'); assert.equal(sha256(fs.readFileSync(result.destination)),sha256(target))
})
for (const [scenario,result] of Object.entries({delta:'delta:1:0','wrong-base':'full:0:1',corrupt:'full:1:1','network-error':'full:1:1',cancel:'rejected:1:0','bad-signature':'rejected:1:1'})) {
  test(`transaction ${scenario}`,()=>assert.equal(run(scenario).output,result))
}
test('wrong base digest rejected before producing output',()=>assert.throws(()=>run('apply','patch','0'.repeat(64))))
test('truncated compressed patch rejected',()=>{fs.writeFileSync(path.join(out,'truncated'),patch.subarray(0,patch.length-8));assert.throws(()=>run('apply','truncated'))})
test('copy beyond base APK rejected',()=>{
  const header=Buffer.alloc(12);header.write('RVBAPK01');header.writeUInt32BE(target.length,8)
  const command=Buffer.alloc(9);command[0]=0;command.writeUInt32BE(base.length,1);command.writeUInt32BE(10,5)
  fs.writeFileSync(path.join(out,'range'),gzipSync(Buffer.concat([header,command,Buffer.from([255])])));assert.throws(()=>run('apply','range'))
})
test('trailing decompressed payload rejected',()=>{fs.writeFileSync(path.join(out,'trailing'),gzipSync(Buffer.concat([gunzipSync(patch),Buffer.from([1])])));assert.throws(()=>run('apply','trailing'))})
test('wrong target byte hash rejected',()=>{
  const modified=Buffer.from(target);modified[100]^=1
  fs.writeFileSync(path.join(out,'wrong-target'),createApkDelta(base,modified).patch);assert.throws(()=>run('apply','wrong-target'))
})
