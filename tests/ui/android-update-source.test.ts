import { beforeAll,describe,it,expect,vi } from 'vitest'
import { build } from 'esbuild'
import vm from 'node:vm'

let code:string
beforeAll(async()=>{
  const result=await build({entryPoints:['android-client/maintenance.ts'],bundle:true,write:false,platform:'browser',format:'iife',plugins:[{name:'native-fixture',setup(b){b.onResolve({filter:/^@capacitor\/core$/},()=>({path:'native',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const registerPlugin=()=>globalThis.nativeFixture;'}))}}]})
  code=result.outputFiles[0].text
})
async function setup(selected='github'){
  const elements=new Map<string,{disabled:boolean;textContent:string;value:string;onclick?:()=>Promise<void>}>()
  for(const id of ['version','updateInfo','profileInfo','activate','previous','updateSource','sourceInfo','check','download','install','notes','saveSource','officialPack','choose','fetchPack','base','clean','cancel','back','message','packUrl'])elements.set(id,{disabled:false,textContent:'',value:''})
  let saved=selected
  const native={info:vi.fn(async()=>({source:saved,version:'0.1.3',config:{updateUrl:'https://official.example/latest',trustedPublisherKeyIds:[]},state:{stable:'base',previous:'base',candidate:null}})),setUpdateSource:vi.fn(async({source}:{source:string})=>{saved=source}),checkUpdate:vi.fn(async()=>({available:true,update:{versionName:'0.1.4',size:100,notes:''}})),downloadUpdate:vi.fn(async()=>({ready:true})),cancel:vi.fn(async()=>{})}
  const buttons=[...elements].filter(([id])=>['activate','previous','check','download','install','saveSource','officialPack','choose','fetchPack','base','clean','back'].includes(id)).map(([,e])=>e)
  vm.runInNewContext(code,{nativeFixture:native,document:{getElementById:(id:string)=>elements.get(id),querySelectorAll:()=>buttons},setInterval:()=>0,TextEncoder,TextDecoder,Uint8Array,atob,console,sessionStorage:{},localStorage:{},location:{}})
  await Promise.resolve();await Promise.resolve()
  return {elements,native}
}
describe('Android shared download-source controls',()=>{
  it('reloads saved COS choice, blocks APK controls and keeps resource download available',async()=>{
    const {elements}=await setup('cos')
    expect(elements.get('updateSource')!.value).toBe('cos')
    expect(elements.get('sourceInfo')!.textContent).toContain('手动切换 GitHub')
    expect(elements.get('check')!.disabled).toBe(true)
    expect(elements.get('officialPack')!.disabled).toBe(false)
  })
  it('invalidates old APK state when changing source and supports manual GitHub return',async()=>{
    const {elements,native}=await setup()
    await elements.get('check')!.onclick!();expect(elements.get('download')!.disabled).toBe(false)
    elements.get('updateSource')!.value='cos';await elements.get('saveSource')!.onclick!()
    expect(native.setUpdateSource).toHaveBeenCalledWith({source:'cos'})
    expect(elements.get('download')!.disabled).toBe(true)
    elements.get('updateSource')!.value='github';await elements.get('saveSource')!.onclick!()
    expect(elements.get('check')!.disabled).toBe(false)
    expect(elements.get('download')!.disabled).toBe(true)
    await elements.get('check')!.onclick!();expect(elements.get('download')!.disabled).toBe(false)
  })
  it('locks the source selector during an operation and clears stale available state after check failure',async()=>{
    const {elements,native}=await setup()
    await elements.get('check')!.onclick!()
    let reject!:(error:Error)=>void
    native.checkUpdate.mockImplementationOnce(()=>new Promise((_resolve,r)=>{reject=r}))
    const checking=elements.get('check')!.onclick!()
    expect(elements.get('updateSource')!.disabled).toBe(true)
    reject(Error('selected source unavailable'));await checking
    expect(elements.get('updateSource')!.disabled).toBe(false)
    expect(elements.get('download')!.disabled).toBe(true)
    expect(elements.get('message')!.textContent).toContain('selected source unavailable')
  })
})
