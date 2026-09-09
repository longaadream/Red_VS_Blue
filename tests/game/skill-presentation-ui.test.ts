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
describe('projected skill display in the actual browser consumers',()=>{
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
