/* eslint-disable @typescript-eslint/no-explicit-any -- Browser APIs are mocked in a VM. */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it, vi } from 'vitest'
function setup(){
 const handlers=new Map<string,(event?: any) => void>(), store=new Map<string,string>(), reduced={matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()},cancel=vi.fn(),target={animate:vi.fn(()=>({cancel}))}
 const w:any={localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v)},matchMedia:()=>reduced,document:{hidden:false,addEventListener:(k:string,f:(event?: any) => void)=>handlers.set(k,f),removeEventListener:vi.fn()}}
 const context=vm.createContext({window:w,Date});for(const file of ['battle-audio','battle-impact'])vm.runInContext(readFileSync('data/pages/js/'+file+'.js','utf8'),context)
 return {w,reduced,target,cancel,handlers,impact:w.BattleImpact.create(target)}
}
const damage=(amount:number)=>[{kind:'damage',result:{amount}}]
it('only shakes for heavy committed damage, with bounded displacement and duration',()=>{
 const s=setup();expect(s.impact.playEvents(damage(7))).toBe(false)
 expect(s.impact.playEvents([{kind:'heal',result:{amount:50}}])).toBe(false)
 expect(s.impact.playEvents([{kind:'damage',result:{amount:50,cancelled:true}}])).toBe(false)
 expect(s.impact.playEvents(damage(10000))).toBe(true)
 expect(s.target.animate.mock.calls[0]).toEqual([[{translate:'0 0'},{translate:'-3px 1px'},{translate:'3px -1px'},{translate:'-2px 0'},{translate:'1px 0'},{translate:'0 0'}],{duration:180,easing:'ease-out'}])
 expect(s.impact.playEvents(damage(10000))).toBe(false);s.impact.dispose()
})
it('stops immediately on input, opt-out, background and disposal; respects reduced motion',()=>{
 const s=setup();s.impact.playEvents(damage(10));s.handlers.get('pointerdown')!();expect(s.cancel).toHaveBeenCalledTimes(1)
 s.w.BattleImpact.setEnabled(false);expect(s.impact.playEvents(damage(10))).toBe(false)
 s.w.BattleImpact.setEnabled(true);s.reduced.matches=true;expect(s.impact.playEvents(damage(10))).toBe(false)
 s.reduced.matches=false;s.w.document.hidden=true;expect(s.impact.playEvents(damage(10))).toBe(false)
 s.impact.dispose();s.w.document.hidden=false;expect(s.impact.playEvents(damage(10))).toBe(false)
 expect(s.w.document.removeEventListener).toHaveBeenCalledWith('pointerdown',expect.any(Function),true)
})
it('disabling shake while it is playing cancels the animation without changing audio volume',()=>{
 const s=setup();s.impact.playEvents(damage(9));const before=s.w.BattleAudio.volume();s.w.BattleImpact.setEnabled(false)
 expect(s.cancel).toHaveBeenCalledTimes(1);expect(s.w.BattleAudio.volume()).toBe(before);s.impact.dispose()
})
