// Isolated Android candidate: current pages, native updates/content and Colyseus host.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { Script } from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
for(const file of fs.readdirSync(path.join(root,'data/pages')).filter(name=>name.endsWith('.html'))){
  const html=fs.readFileSync(path.join(root,'data/pages',file),'utf8')
  for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!/type\s*=/.test(script[1]))new Script(script[2],{filename:file})
}
// Never accept stale browser engine/AI output when Gradle rebuilds this APK.
for (const script of ['scripts/build-practice-ai.mjs','scripts/build-game-engine.js']) {
  execFileSync(process.execPath,[path.join(root,script),'--windows-only'],{cwd:root,stdio:'inherit'})
}
const generated = path.join(root, 'android/app/build/generated/ui-acceptance-assets')
const pages = path.join(generated, 'public')
// This generated subtree is exclusively owned by this script.
if (!generated.startsWith(path.join(root, 'android/app/build') + path.sep)) throw Error('Invalid staging path')
fs.rmSync(generated, {recursive:true,force:true})
fs.mkdirSync(pages,{recursive:true})
fs.cpSync(path.join(root,'data/pages'),pages,{recursive:true})
fs.cpSync(path.join(root,'public'),path.join(pages,'images'),{recursive:true,force:false})
fs.cpSync(path.join(root,'data'),path.join(pages,'data'),{recursive:true,filter:source=>source!==path.join(root,'data/pages')&&source!==path.join(root,'data/users.json')})
const adapter = path.join(root,'android/app/build/ui-acceptance-resources.cjs')
await build({stdin:{contents:`export { readClientProtocolBattleData } from './electron-client/client-protocol-resource'; export { createGameProfileIdentityV1 } from './lib/content-pipeline/runtime/profile-game-identity'; export { getBundledBaseProfileV1, createBundledBasePackInputV1 } from './lib/content-pipeline/runtime/bundled-base';`,resolveDir:root,loader:'ts'},outfile:adapter,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'warning'})
const api=createRequire(import.meta.url)(adapter)
const base=api.createBundledBasePackInputV1(root).source
const hostBase=path.join(root,'android/app/build/generated/android-host-assets/host-base')
if(fs.existsSync(hostBase))fs.rmSync(hostBase,{recursive:true})
for(const file of base.entries){const target=path.join(hostBase,file.path.startsWith('images/')?'public/'+file.path:file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes)}
const {writeHostManifest}=await import('./build-android-host.mjs')
writeHostManifest()
await build({entryPoints:[path.join(root,'android-client/host.ts')],outfile:path.join(pages,'js/android-host.js'),bundle:true,platform:'browser',format:'iife',minify:true})
for(const name of fs.readdirSync(pages).filter(name=>name.endsWith('.html'))){const file=path.join(pages,name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('<head>','<head><script src="js/android-host.js"></script>'))}
for(const file of base.entries){const target=path.join(pages,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes)}
fs.writeFileSync(path.join(generated,'android-base.json'),JSON.stringify({manifest:Buffer.from(base.manifestBytes).toString('base64'),signature:Buffer.from(base.signatureBytes).toString('base64'),paths:base.entries.map(f=>f.path)}))
fs.writeFileSync(path.join(generated,'android-base-profile.json'),JSON.stringify({profile:api.getBundledBaseProfileV1(root).profile,chain:['base']}))
const distribution=process.env.RVB_ANDROID_DISTRIBUTION_CONFIG?JSON.parse(fs.readFileSync(path.resolve(process.env.RVB_ANDROID_DISTRIBUTION_CONFIG),'utf8')):{updateUrl:'https://github.com/longaadream/Red_VS_Blue/releases/latest/download/android-latest.json',trustedPublisherKeyIds:[]}
if(Object.keys(distribution).some(key=>!['updateUrl','trustedPublisherKeyIds'].includes(key))||typeof distribution.updateUrl!=='string'||(distribution.updateUrl&&!distribution.updateUrl.startsWith('https://'))||!Array.isArray(distribution.trustedPublisherKeyIds)||distribution.trustedPublisherKeyIds.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)))throw Error('Invalid Android distribution config (public metadata only)')
fs.writeFileSync(path.join(generated,'android-distribution.json'),JSON.stringify(distribution))
const res=path.join(root,'android/app/build/generated/android-distribution-res')
fs.rmSync(res,{recursive:true,force:true});fs.mkdirSync(path.join(res,'xml'),{recursive:true})
let qaTrust=''
if(process.env.RVB_ANDROID_QA_CERT){
  fs.mkdirSync(path.join(res,'raw'),{recursive:true});fs.copyFileSync(path.resolve(process.env.RVB_ANDROID_QA_CERT),path.join(res,'raw/android_qa_ca.pem'))
  qaTrust='<debug-overrides><trust-anchors><certificates src="@raw/android_qa_ca" /></trust-anchors></debug-overrides>'
}
fs.writeFileSync(path.join(res,'xml/android_distribution_network.xml'),`<network-security-config><base-config cleartextTrafficPermitted="true"><trust-anchors><certificates src="system" /></trust-anchors></base-config><domain-config cleartextTrafficPermitted="true"><domain>localhost</domain><domain>127.0.0.1</domain></domain-config>${qaTrust}</network-security-config>`)
await build({entryPoints:[path.join(root,'android-client/maintenance.ts')],outfile:path.join(pages,'js/android-maintenance.js'),bundle:true,platform:'browser',format:'iife',minify:true})
const files=api.readClientProtocolBattleData({htmlRoot:path.join(root,'data/pages'),appRoot:root,activePackRoot:null,isPackaged:false})
fs.writeFileSync(path.join(pages,'__battle-data.json'),JSON.stringify({schemaVersion:'rvb-client-battle-data/v1',files}))
fs.writeFileSync(path.join(pages,'__tutorial-profile.json'),JSON.stringify(api.createGameProfileIdentityV1(api.getBundledBaseProfileV1(root).profile)))
await build({entryPoints:[path.join(root,'scripts/crypto-lib-entry.js')],outfile:path.join(pages,'js/crypto-lib.js'),bundle:true,platform:'browser',format:'iife',globalName:'CryptoLib',define:{'process.env.NODE_ENV':'"production"'},minify:true})
fs.writeFileSync(path.join(generated,'capacitor.config.json'),JSON.stringify({appId:'com.redvsblue.client.uiqa',appName:'红蓝对决·界面验收',webDir:'public',server:{androidScheme:'https'},plugins:{SystemBars:{hidden:true}}}))
fs.writeFileSync(path.join(generated,'capacitor.plugins.json'),'[]')
for (const required of ['battle.html','css/battle-landscape.css','js/battle-ui/mobile-battle-controls.js','js/game-engine.js','tabletop-battle/character-dock.js','__battle-data.json']) {
  if(!fs.statSync(path.join(pages,required)).size) throw Error('Missing acceptance asset: '+required)
}
console.log('Staged isolated Android UI acceptance assets: '+generated)
for (const directory of [path.join(pages,'data'),path.join(hostBase,'data')]) {
  if(fs.existsSync(path.join(directory,'users.json'))) throw Error('Development accounts must not be packaged')
}
