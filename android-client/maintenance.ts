import { registerPlugin } from '@capacitor/core'
import { appendAndroidPack, resolveAndroidProfile, type AndroidPackInput } from '../lib/content-pipeline/android/resolve'
import { PackSignatureEnvelopeV1Schema } from '../lib/content-pipeline/contracts'
import { parseStrictJsonBytesV1 } from '../lib/content-pipeline/core/json-safety'

interface Native {
  info(): Promise<{version:string; versionCode:number; progress:string;config:{updateUrl:string;trustedPublisherKeyIds:string[]};state:{stable:string;previous:string;candidate:string|null}}>
  checkUpdate():Promise<{available:boolean;update?:{versionName:string;notes:string;size:number}}>
  downloadUpdate():Promise<unknown>; installUpdate():Promise<{message:string}>; cancel():Promise<void>
  choosePack():Promise<{id?:string;cancelled?:boolean}>; downloadPack(args:{url:string}):Promise<{id:string}>
  readSource(args:{id:string}):Promise<{manifest:string;signature:string;paths:string[]}>
  readSourceFile(args:{id:string;path:string}):Promise<{base64:string}>
  readProfile(args:{id:string}):Promise<{chain:string[]}>
  commitCandidate(args:{record:ReturnType<typeof resolveAndroidProfile>}):Promise<unknown>
  discardSource(args:{id:string}):Promise<void>; activate(args:{target:string}):Promise<unknown>;cleanUnused():Promise<void>
  trustPublisher(args:{keyId:string}):Promise<{trusted:boolean}>
}
const native=registerPlugin<Native>('AndroidMaintenance')
const el=(id:string)=>document.getElementById(id)!
const button=(id:string)=>el(id) as HTMLButtonElement
const say=(text:string)=>{el('message').textContent=text}
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0))
let busy=false
let info:Awaited<ReturnType<Native['info']>>
function assertNoReservedBattle(){
  const records=Object.keys(sessionStorage).filter(key=>key.startsWith('rvb_colyseus_reconnect:'))
  if(records.some(key=>!key.endsWith(':profile')&&sessionStorage.getItem(key))){
    if(!confirm('仍有对局重连记录，建议先返回对局。继续将放弃本机自动重连记录；服务器上的对局按原规则继续处理。确定继续更新或切换资源吗？'))throw Error('已取消，请先返回对局')
    records.forEach(key=>sessionStorage.removeItem(key))
  }
}
async function refresh(){
  info=await native.info()
  el('version').textContent=info.version
  el('updateInfo').textContent=info.config.updateUrl?'可检查发行者提供的新版本':'尚未配置线上更新源；当前版本仍可离线使用'
  el('profileInfo').textContent=`当前：${info.state.stable==='base'?'内置资源':info.state.stable.slice(0,12)}${info.state.candidate?' · 候选 '+info.state.candidate.slice(0,12):''}`
  button('activate').disabled=!info.state.candidate
  button('previous').disabled=info.state.previous===info.state.stable
}
async function source(id:string):Promise<AndroidPackInput>{
  const meta=await native.readSource({id});const entries=[]
  for(const path of meta.paths){if(path==='manifest.json'||path==='signature.json')continue;const file=await native.readSourceFile({id,path});entries.push({path,bytes:decode(file.base64)})}
  return{id,source:{manifestBytes:decode(meta.manifest),signatureBytes:decode(meta.signature),entries}}
}
async function importSource(id:string){
  try{
    say('正在验证签名、内容和兼容性…')
    const bundled=await source('base'),incoming=await source(id)
    const parentRecord=await native.readProfile({id:info.state.stable})
    const parent=[]
    for(const key of parentRecord.chain)parent.push(key==='base'?bundled:await source(key))
    const envelope=PackSignatureEnvelopeV1Schema.parse(parseStrictJsonBytesV1(incoming.source.signatureBytes!))
    const known=info.config.trustedPublisherKeyIds.includes(envelope.keyId)
    // Validate all content and the actual signature before offering a native trust decision.
    const record=appendAndroidPack(bundled,parent,incoming,[...info.config.trustedPublisherKeyIds,envelope.keyId])
    if(!known && !(await native.trustPublisher({keyId:envelope.keyId})).trusted)throw Error('未信任发行者，资源包未安装')
    await native.commitCandidate({record});say('校验通过，已保存候选版本。点击“启用候选版本”后生效。')
  }catch(error){await native.discardSource({id}).catch(()=>{});throw error}
}
function action(id:string,run:()=>Promise<void>){button(id).onclick=async()=>{
  if(busy)return;busy=true;const disabled=new Map<HTMLButtonElement,boolean>();document.querySelectorAll<HTMLButtonElement>('button:not(#cancel)').forEach(b=>{disabled.set(b,b.disabled);b.disabled=true})
  try{await run()}catch(e){say(e instanceof Error?e.message:String(e))}finally{busy=false;disabled.forEach((value,b)=>{b.disabled=value});await refresh().catch(e=>say(String(e)))}
}}
action('check',async()=>{button('download').disabled=true;button('install').disabled=true;const r=await native.checkUpdate();el('notes').textContent=r.available?`${r.update!.versionName} · ${(r.update!.size/1024/1024).toFixed(1)} MiB\n${r.update!.notes||''}`:'';say(r.available?'发现新版本，可下载更新':'当前已是最新版本');setTimeout(()=>{button('download').disabled=!r.available},0)})
action('download',async()=>{say('正在下载 APK…');await native.downloadUpdate();say('下载和签名校验通过，可安装更新');setTimeout(()=>{button('install').disabled=false},0)})
action('install',async()=>{assertNoReservedBattle();say((await native.installUpdate()).message)})
action('choose',async()=>{const r=await native.choosePack();if(r.id)await importSource(r.id);else say('已取消选择')})
action('fetchPack',async()=>{const url=(el('packUrl') as HTMLInputElement).value.trim();if(!url.startsWith('https://'))throw Error('请输入HTTPS资源包地址');say('正在下载资源包…');const r=await native.downloadPack({url});await importSource(r.id)})
for(const target of ['candidate','previous','base'])action(target==='candidate'?'activate':target,async()=>{
  assertNoReservedBattle()
  if(!confirm('切换资源版本？返回主菜单后新对局将使用该版本。'))return
  // Revalidate the complete signed chain before every activation, including rollback.
  const hash=target==='candidate'?info.state.candidate!:target==='previous'?info.state.previous:'base'
  const bundled=await source('base'),record=await native.readProfile({id:hash}),chain=[]
  for(const id of record.chain)chain.push(id==='base'?bundled:await source(id))
  const resolved=resolveAndroidProfile(bundled,chain,info.config.trustedPublisherKeyIds)
  if(hash!=='base'&&resolved.profile.resolvedProfileHash!==hash)throw Error('资源身份与已安装版本不一致')
  await native.activate({target});localStorage.removeItem('rvb_game_profile_identity');localStorage.removeItem('rvb_server_profile_identity');say('资源已切换，返回主菜单即可使用')
})
action('clean',async()=>{await native.cleanUnused();say('未使用的资源已清理，当前和上一版已保留')})
button('cancel').onclick=()=>{void native.cancel().then(()=>say('已请求取消下载'))}
// Static Capacitor pages do not use the Next router.
// eslint-disable-next-line @next/next/no-location-assign-relative-destination
button('back').onclick=()=>{location.href='index.html'}
let lastProgress=''
setInterval(()=>{if(busy)void native.info().then(r=>{if(r.progress&&r.progress!==lastProgress){lastProgress=r.progress;say(r.progress)}}).catch(()=>{})},800)
void refresh().catch(e=>say(String(e)))
