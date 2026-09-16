/* eslint-disable @typescript-eslint/no-explicit-any -- Actual browser modules are loaded in a VM. */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { createSkillPresentation } from '../../lib/game/skill-presentation'
import { toPublicBattleState } from '../../lib/game/deployment'
import { makePiece, makeState } from '../helpers/minimal-state'

function browser() {
  const window:any={}, context=createContext({window,globalThis:window,console})
  for(const name of ['battle-skill-presentation','battle-view-model','battle-dom-ui','battle-presentation']) new Script(readFileSync(resolve('data/pages/js/battle-ui/'+name+'.js'),'utf8')).runInContext(context)
  return window
}

function queuedAudio() {
  const w=browser(),context=createContext({window:w,globalThis:w,console})
  const impact={playEvents:vi.fn(),stop:vi.fn(),dispose:vi.fn()}
  w.BattleImpact={create:()=>impact}
  for(const path of ['battle-audio.js','battle-ui/battle-action-vignette.js']) new Script(readFileSync(resolve('data/pages/js/'+path),'utf8')).runInContext(context)
  const play=vi.fn(),renderer={init:vi.fn(),update:vi.fn(),dispose:vi.fn()}
  let queue:any
  const vignetteUi={
    sequencesBoard:true,
    mount:(options:any)=>{queue=w.BattleActionVignette.createQueue({
      onPhase:options.onPlaybackPhase,onIdle:options.onPlaybackIdle,
      now:()=>Date.now(),setTimeout:(fn:()=>void,delay:number)=>setTimeout(fn,delay),clearTimeout:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),
    })},
    update:(model:any)=>queue.update(model),reset:(model:any)=>queue.reset(model),
    settleAll:()=>queue.settleAll(),getDiagnostics:()=>queue.getDiagnostics(),dispose:()=>queue.dispose(),
  }
  const p=w.BattlePresentation.create({renderer,domUi:{update:vi.fn(),dispose:vi.fn()},vignetteUi,
    skillAudio:{playEvents:(events:any[])=>w.BattleAudio.soundsFor(events).forEach((kind:string)=>play(kind)),dispose:vi.fn()}})
  p.mount({})
  const model=(events:any[])=>({viewer:{id:'red'},board:{},turn:{isViewerTurn:false},effects:[],pieces:[],presentationEvents:events})
  p.update(model([]))
  return {p,play,model,impact,skip:()=>queue.skip()}
}
describe('projected skill display in the actual browser consumers',()=>{
  it('triggers impact only at the live result, once, and cancels on skip/recovery',()=>{
    vi.useFakeTimers()
    const {p,model,impact,skip}=queuedAudio()
    const event={eventId:'hit',rootEventId:'hit',kind:'damage',sequence:0,result:{amount:10}}
    try {
      p.update(model([event]));expect(impact.playEvents).not.toHaveBeenCalled()
      vi.advanceTimersByTime(420);expect(impact.playEvents).toHaveBeenCalledTimes(1)
      skip();expect(impact.stop).toHaveBeenCalled()
      vi.runAllTimers();p.update(model([event]));expect(impact.playEvents).toHaveBeenCalledTimes(1)
      p.beginSkillRecovery();p.completeSkillRecovery()
      p.update(model([event,{...event,eventId:'recovered',rootEventId:'recovered'}]));vi.runAllTimers()
      expect(impact.playEvents).toHaveBeenCalledTimes(1)
    } finally {p.dispose();vi.useRealTimers()}
    expect(impact.dispose).toHaveBeenCalledTimes(1)
  })
  it('plays a movement sound for the player action through the real queue',()=>{
    vi.useFakeTimers()
    const {p,play,model}=queuedAudio()
    const events=[{eventId:'walk',rootEventId:'walk',kind:'move',sequence:0,sourcePieceId:'a',result:{fromX:1,fromY:1,toX:2,toY:1}}]
    try {
      p.update({...model([]),turn:{isViewerTurn:true}})
      p.update({...model(events),turn:{isViewerTurn:true}})
      vi.advanceTimersByTime(120)
      expect(play).toHaveBeenCalledExactlyOnceWith('move')
      vi.runAllTimers()
      p.update({...model(events),turn:{isViewerTurn:true}})
      expect(play).toHaveBeenCalledTimes(1)
    } finally {p.dispose();vi.useRealTimers()}
  })
  it('silences an already queued result during recovery before another snapshot arrives',()=>{
    vi.useFakeTimers()
    const {p,play,model}=queuedAudio()
    try {
      p.update(model([{eventId:'queued',rootEventId:'queued',kind:'damage',sequence:0,result:{amount:2}}]))
      p.beginSkillRecovery()
      vi.runAllTimers()
      expect(play).not.toHaveBeenCalled()
    } finally {p.dispose();vi.useRealTimers()}
  })
  it.each([false,true])('does not replay basic sounds on recovery and plays subsequent new actions (intermediate snapshot: %s)',intermediate=>{
    vi.useFakeTimers()
    const {p,play,model}=queuedAudio()
    const damage=(id:string)=>({eventId:id,rootEventId:id,kind:'damage',sequence:0,result:{amount:2}})
    try {
      p.beginSkillRecovery()
      if(intermediate){p.update(model([damage('during-recovery')]));vi.runAllTimers()}
      p.completeSkillRecovery()
      const recovered=[damage('during-recovery'),damage('catch-up')]
      p.update(model(recovered));vi.runAllTimers()
      expect(play).not.toHaveBeenCalled()
      p.update(model([...recovered,damage('new-action')]));vi.runAllTimers()
      expect(play).toHaveBeenCalledExactlyOnceWith('damage')
    } finally {p.dispose();vi.useRealTimers()}
  })
  it('plays one sound for each real queue AOE batch while preserving separate hit batches',()=>{
    vi.useFakeTimers()
    const {p,play,model}=queuedAudio()
    const root={eventId:'action:0',rootEventId:'action:0',kind:'skill',sequence:0}
    const hit=(sequence:number,batchId:string)=>({eventId:'action:'+sequence,rootEventId:root.eventId,parentEventId:root.eventId,
      kind:'damage',sequence,batchId,targetPieceIds:['target-'+sequence],result:{amount:2}})
    try {
      const events=[root,hit(1,'aoe-first'),hit(2,'aoe-first'),hit(3,'aoe-second'),hit(4,'aoe-second')]
      p.update(model(events));vi.runAllTimers()
      expect(play.mock.calls).toEqual([['damage'],['damage']])
      p.update(model(events));vi.runAllTimers()
      expect(play).toHaveBeenCalledTimes(2)
    } finally {p.dispose();vi.useRealTimers()}
  })
  it('plays basic audio once per animated action and stays silent when animations are skipped',()=>{
    const w=browser(), renderer={init:vi.fn(),update:vi.fn(),dispose:vi.fn()},domUi={update:vi.fn(),dispose:vi.fn()}
    let phase:any
    const skillAudio={playEvents:vi.fn(),dispose:vi.fn()}
    const vignetteUi={mount:(o:any)=>{phase=o.onPlaybackPhase},update:vi.fn(),dispose:vi.fn()}
    const p=w.BattlePresentation.create({renderer,domUi,vignetteUi,skillAudio})
    p.mount({})
    p.update({viewer:{id:'red'},board:{},turn:{},effects:[],pieces:[],presentationEvents:[]})
    expect(skillAudio.playEvents).not.toHaveBeenCalled()
    const group=(id:string)=>({rootEventId:id,root:{kind:'damage',rootEventId:id,eventId:id,result:{amount:2}},children:[]})
    phase('result',group('one'));phase('result',group('one'));phase('settle',group('one'))
    expect(skillAudio.playEvents).toHaveBeenCalledTimes(1)
    phase('settle',group('skipped'));phase('result',group('skipped'))
    expect(skillAudio.playEvents).toHaveBeenCalledTimes(1)
    phase('static',group('reduced-motion'))
    expect(skillAudio.playEvents).toHaveBeenCalledTimes(2)
    p.dispose()
  })
  it('passes authoritative teleport/swap kinds to the renderer without mutating the model',()=>{
    const w=browser(),renderer={init:vi.fn(),update:vi.fn(),dispose:vi.fn(),animateAction:vi.fn()},domUi={update:vi.fn(),dispose:vi.fn()}
    let phase:any
    const vignetteUi={mount:(options:any)=>{phase=options.onPlaybackPhase},update:vi.fn(),dispose:vi.fn()}
    const controller=w.BattlePresentation.create({renderer,domUi,vignetteUi})
    controller.mount({})
    const model={viewer:{id:'red'},board:{},turn:{},effects:[],pieces:[{id:'a',x:0,y:0}],presentationEvents:[]}
    controller.update(model)
    const group={rootEventId:'root',root:{kind:'forceMove',rootEventId:'root',eventId:'root',targetPieceIds:['a'],
      result:{movementKind:'teleport',fromX:0,fromY:0,toX:2,toY:0}},children:[]}
    const before=JSON.stringify(model)
    phase('path',group)
    expect(renderer.animateAction).toHaveBeenCalledWith(expect.objectContaining({movementKinds:{a:'teleport'}}),expect.anything(),
      expect.objectContaining({pieces:[expect.objectContaining({id:'a',x:2,y:0})]}))
    expect(JSON.stringify(model)).toBe(before)
    controller.dispose()
  })
  it('renders binding, progress and map markers from a real authority projection, with escaped labels',()=>{
    const state=makeState({pieces:[makePiece({instanceId:'a',currentHp:9}),makePiece({instanceId:'b',currentHp:1,x:1})]})
    state.pieces[0].name='本体'
    const api=createSkillPresentation(state,'player-red','demo','a')
    api.bind({id:'mirror',audience:'public',sourceId:'a',targetId:'b',fields:['health','name'],mode:'live',onSourceMissing:'snapshot'})
    api.indicator({id:'progress',audience:'owner',targetId:'b',label:'<script>bad()</script>',value:3,max:6})
    api.mark({id:'anchor',audience:'owner',cells:[{x:2,y:1}],label:'预留显示',icon:'⚡'})
    const w=browser(), snapshot=toPublicBattleState(state,'player-red')
    const model=w.BattleViewModel.create({snapshot,viewerId:'player-red',presentationScope:'match1'})
    expect(model.pieces[1]).toMatchObject({name:'本体',health:{current:9},alive:true})
    expect(state.pieces[1].currentHp).toBe(1)
    expect(model.effects[0]).toMatchObject({type:'flying-raijin-anchor',x:2,y:1,label:'预留显示'})
    const panel:any={innerHTML:'',hidden:false,remove:vi.fn()}
    w.BattleDomUI.create({document:{getElementById:(id:string)=>id==='skillPresentationIndicators'?panel:null}}).update(model)
    expect(panel.innerHTML).toContain('&lt;script&gt;')
    expect(panel.innerHTML).not.toContain('<script>')
    expect(panel.innerHTML).toContain('<progress max="6" value="3"')
    expect(panel.innerHTML).toContain('预留显示')
    expect(w.BattleViewModel.create({snapshot:toPublicBattleState(state,'player-blue'),viewerId:'player-blue'}).skillIndicators).toEqual([])
    expect(w.BattleSkillPresentation.read(state)).toEqual({})
  })
  it('does not replay old cues on initialization, reordered delivery, reconnect or viewpoint changes',()=>{
    const w=browser(), cursor=w.BattleSkillPresentation.createPlayback()
    const model=(scope:string,ids:number[])=>({skillPresentationScope:scope,skillCues:ids.map(id=>({id:'p-'+id,kind:'float',x:1,y:1,text:'cue'}))})
    expect(cursor.consume(model('room1:owner',[1,2]))).toEqual([])
    expect(cursor.consume(model('room1:owner',[2,3,4]))).toHaveLength(2)
    expect(cursor.consume(model('room1:owner',[1,3]))).toEqual([])
    expect(cursor.consume(model('room1:enemy',[1,2,4]))).toEqual([])
    expect(cursor.consume(model('room1:enemy',[4,5]))).toHaveLength(1)
    cursor.reset()
    expect(cursor.consume(model('room1:enemy',[4,5]))).toEqual([])
    expect(cursor.consume(model('room2:enemy',[1]))).toEqual([])
    expect(cursor.consume(model('room2:enemy',[2]))).toHaveLength(1)
  })
  it('the battle controller consumes new cues without modifying the model',()=>{
    const w=browser(), renderer={init:vi.fn(),update:vi.fn(),dispose:vi.fn(),spawnFloater:vi.fn(),showPresentationAreaFlash:vi.fn()},domUi={update:vi.fn(),dispose:vi.fn()}
    const skillAudio={play:vi.fn(),dispose:vi.fn()}
    const p=w.BattlePresentation.create({renderer,domUi,skillAudio})
    p.mount({})
    const model:any={viewer:{id:'red'},board:{},pieces:[],effects:[],turn:{},skillPresentationScope:'match:red',skillCues:[]}
    p.update(model)
    const next={...model,skillCues:[{id:'p-1',kind:'float',x:1,y:2,text:'提示'},{id:'p-2',kind:'flash',x:1,y:2,text:'闪光'},{id:'p-0-owner-1',kind:'sound',sound:'success',x:1,y:2,text:'成功'}]}
    const before=JSON.stringify(next)
    p.update(next);p.update(next)
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(1)
    expect(renderer.showPresentationAreaFlash).toHaveBeenCalledTimes(1)
    expect(renderer.showPresentationAreaFlash).toHaveBeenCalledWith([{x:1,y:2}],{transient:true})
    expect(skillAudio.play).toHaveBeenCalledExactlyOnceWith('success')
    expect(JSON.stringify(next)).toBe(before)
    p.beginSkillRecovery()
    const recovered={...model,skillCues:[{id:'p-3',kind:'float',x:1,y:2,text:'断线历史'}]}
    p.update(next)
    p.completeSkillRecovery()
    p.update(recovered)
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(1)
    p.update({...recovered,skillCues:[...recovered.skillCues,{id:'p-4',kind:'float',x:1,y:2,text:'恢复后的新效果'}]})
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(2)
    const page=readFileSync(resolve('data/pages/battle.html'),'utf8')
    expect(page).toMatch(/on\('disconnect'[\s\S]{0,150}beginSkillRecovery/)
    expect(page).toMatch(/function applyServerState[\s\S]{0,250}completeSkillRecovery/)
    p.dispose()
  })
})
