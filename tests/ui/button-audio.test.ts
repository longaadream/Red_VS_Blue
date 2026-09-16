import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {it,expect,vi} from 'vitest'
it('plays only enabled user buttons; restores sound after page history navigation',()=>{
 const handlers=new Map<string,(event?: unknown)=>void>()
 const audio={unlock:vi.fn(),play:vi.fn(),dispose:vi.fn()}
 const create=vi.fn(()=>audio)
 const listen=(name:string,fn:(event?:unknown)=>void)=>handlers.set(name,fn)
 runInNewContext(readFileSync('data/pages/js/button-audio.js','utf8'),{window:{document:{readyState:'complete',addEventListener:listen},addEventListener:listen,BattleAudio:{create}}})
 let disabled=false,excluded=false
 const button={matches:()=>disabled,closest:()=>excluded}
 const event={isTrusted:true,target:{closest:()=>button}}
 handlers.get('click')!(event);expect(audio.play).toHaveBeenCalledWith('click')
 disabled=true;handlers.get('click')!(event)
 disabled=false;excluded=true;handlers.get('click')!(event)
 excluded=false;handlers.get('click')!({...event,isTrusted:false})
 expect(audio.play).toHaveBeenCalledTimes(1)
 handlers.get('pagehide')!();expect(audio.dispose).toHaveBeenCalledOnce()
 handlers.get('pageshow')!();expect(create).toHaveBeenCalledTimes(2)
 handlers.get('click')!(event);expect(audio.play).toHaveBeenCalledTimes(2)
})
