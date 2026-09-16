/* eslint-disable @typescript-eslint/no-explicit-any -- Browser module and Web Audio fakes are exercised in a VM. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { describe, it, expect, vi } from 'vitest'

function setup() {
  const listeners = new Map<string, () => void>()
  const sources: any[] = []
  let saved: string | null = null
  const parameter = () => ({setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()})
  class Audio {
    state = 'running'; currentTime = 1; destination = {}; close = vi.fn(async()=>{}); resume = vi.fn(async()=>{})
    createGain() {return {gain:parameter(),connect:vi.fn(),disconnect:vi.fn()}}
    createOscillator() {const s={frequency:parameter(),connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn()};sources.push(s);return s}
  }
  const w:any={AudioContext:Audio,localStorage:{getItem:()=>saved,setItem:(_:string,v:string)=>{saved=v}},document:{hidden:false,addEventListener:(type:string,fn:() => void)=>listeners.set(type,fn),removeEventListener:vi.fn()}}
  const context=createContext({window:w,console})
  new Script(readFileSync('data/pages/js/battle-ui/battle-effect-icons.js','utf8')).runInContext(context)
  new Script(readFileSync('data/pages/js/battle-audio.js','utf8')).runInContext(context)
  return {w,listeners,sources,setVolume:(value:string)=>{saved=value}}
}
describe('battle audio feedback',()=>{
  it('grades committed magnitudes and takes the strongest area target rather than summing damage',()=>{
    const {w}=setup(), audio=w.BattleAudio
    expect([1,3,4,7,8,999].map(n=>audio.tierFor('damage',n))).toEqual([0,0,1,1,2,2])
    expect([1,2,3,4,5,999].map(n=>audio.tierFor('move',n))).toEqual([0,0,1,1,2,2])
    expect(audio.cuesFor([{kind:'damage',result:{amount:3}},{kind:'damage',result:{amount:3}},{kind:'damage',result:{amount:5}},{kind:'heal',result:{amount:8}}])).toEqual([{kind:'damage',value:5,tier:1},{kind:'heal',value:8,tier:2}])
    expect(audio.cuesFor([{kind:'damage',result:{amount:Infinity}},{kind:'heal',result:{amount:-5}},{kind:'move',result:{}},{kind:'move',result:{fromX:1,fromY:1,toX:1,toY:1}}])).toEqual([])
  })
  it('uses projected displacement without confusing teleport with walking',()=>{
    const {w}=setup(), audio=w.BattleAudio
    expect(audio.cuesFor([{kind:'move',result:{fromX:0,fromY:0,toX:6,toY:0}}])).toEqual([{kind:'move',value:6,tier:2}])
    expect(audio.cuesFor([{kind:'forceMove',result:{fromX:0,fromY:0,toX:6,toY:0,movementKind:'teleport'}}])[0].kind).toBe('teleport')
  })
  it('changes the actual synthesized damage timbre and duration while keeping it bounded',()=>{
    const render=(value:number)=>{const s=setup(),a=s.w.BattleAudio.create();a.unlock();a.playEvents([{kind:'damage',result:{amount:value}}]);return s.sources[0]}
    const light=render(2),heavy=render(10),huge=render(100000)
    expect(heavy.frequency.setValueAtTime.mock.calls[0][0]).toBeLessThan(light.frequency.setValueAtTime.mock.calls[0][0])
    expect(heavy.stop.mock.calls[0][0]).toBeGreaterThan(light.stop.mock.calls[0][0])
    expect(huge.stop.mock.calls).toEqual(heavy.stop.mock.calls)
  })
  it('keeps strengthening and weakening effects silent',()=>{
    const {w}=setup()
    const event=(statusType:string)=>({kind:'statusAdded',statusType})
    expect(w.BattleAudio.soundsFor([event('silenced'),event('root')])).toEqual([])
    expect(w.BattleAudio.soundsFor([event('divine-shield'),{kind:'statChanged',result:{amount:2}}])).toEqual([])
    expect(w.BattleAudio.soundsFor([event('not-registered')])).toEqual([])
  })
  it('groups area effects and excludes cancelled or zero effects',()=>{
    const {w}=setup()
    expect(w.BattleAudio.soundsFor([{kind:'damage',result:{amount:2}},{kind:'damage',result:{amount:5}},{kind:'heal',result:{amount:0}},{kind:'move',result:{cancelled:true}},{kind:'statChanged',result:{amount:2}}])).toEqual(['damage'])
  })
  it('does not autoplay, respects mute/background/disposal and limits simultaneous voices',()=>{
    const {w,listeners,sources,setVolume}=setup(),audio=w.BattleAudio.create()
    expect(audio.play('heal')).toBe(false)
    listeners.get('pointerdown')!()
    expect(audio.play('heal')).toBe(true)
    expect(audio.play('heal')).toBe(false)
    setVolume('0');expect(audio.play('damage')).toBe(false)
    setVolume('1');w.document.hidden=true;expect(audio.play('damage')).toBe(false)
    w.document.hidden=false
    for(const kind of ['damage','move','buff','debuff','teleport','notice'])audio.play(kind)
    expect(sources.length).toBeLessThanOrEqual(12)
    audio.dispose();expect(audio.play('move')).toBe(false)
    expect(w.document.removeEventListener).toHaveBeenCalledWith('pointerdown',expect.any(Function))
  })
  it('stops already scheduled sounds on mute and when the page becomes hidden',()=>{
    const {w,listeners,sources}=setup(),audio=w.BattleAudio.create()
    listeners.get('pointerdown')!()
    audio.play('heal')
    w.BattleAudio.setVolume(0)
    expect(w.BattleAudio.volume()).toBe(0)
    for(const source of sources) expect(source.stop).toHaveBeenLastCalledWith()
    w.BattleAudio.setVolume(0.5)
    audio.play('damage')
    w.document.hidden=true
    listeners.get('visibilitychange')!()
    for(const source of sources) expect(source.stop).toHaveBeenLastCalledWith()
    audio.dispose()
    expect(w.document.removeEventListener).toHaveBeenCalledWith('visibilitychange',expect.any(Function))
  })
  it('can unlock immediately after raising a previously muted volume',()=>{
    const {w,sources,setVolume}=setup(),audio=w.BattleAudio.create()
    setVolume('0');audio.unlock()
    expect(audio.play('heal')).toBe(false)
    w.BattleAudio.setVolume(0.45);audio.unlock()
    expect(audio.play('heal')).toBe(true)
    expect(sources).toHaveLength(3)
  })
})


