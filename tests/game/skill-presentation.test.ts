/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise legacy battle snapshots and trusted author inputs. */
import { describe, expect, it } from 'vitest'
import { createSkillPresentation, type PresentationAudience } from '../../lib/game/skill-presentation'
import { createSkillCodeFlow } from '../../lib/game/skills'
import { toPublicBattleState } from '../../lib/game/deployment'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'
import { createDebugDuel } from '../../lib/game/debug-battle'
import { hashStable, runBattleAction } from '../../lib/game/battle-runner'

function fixture() {
  const state=makeState({pieces:[makePiece({instanceId:'source',name:'本体',currentHp:7,maxHp:10,statusTags:[{type:'divine-shield',name:'圣盾',visible:true},{type:'secret',visible:false}] as any}),makePiece({instanceId:'copy',currentHp:1,maxHp:1,x:1})]})
  state.players=[{...makePlayer('player-red','red'),teamId:'red'},{...makePlayer('ally','red'),teamId:'red'},{...makePlayer('enemy','blue'),teamId:'blue'}] as any
  state.pieces[0].name='本体'
  return state
}
function api(state=fixture()) { return createSkillPresentation(state,'player-red','test','source') }
function shown(state: ReturnType<typeof fixture>, viewer?:string) { return toPublicBattleState(state,viewer).extensions!.skillPresentation }
const bind = {id:'mask',audience:'public' as const,targetId:'copy',sourceId:'source',fields:['health','statuses','name'] as const,mode:'live' as const,onSourceMissing:'snapshot' as const}

describe('skill presentation authority and projection',()=>{
  it('keeps private declarations out of real terminal replay checkpoints and preserves checkpoint hashes',async()=>{
    const duel=await createDebugDuel({seed:202,beginPhase:false}), state=duel.state
    const target=state.pieces.find(p=>p.currentHp>0 && p.x!==null)!
    createSkillPresentation(state,'debug-red','private').indicator({id:'secret',audience:'owner',targetId:target.instanceId,label:'PRIVATE-INDICATOR-202',value:713})
    const result=runBattleAction(state,{type:'surrender',playerId:'debug-blue',reason:'voluntary'}).state
    const archive=toPublicBattleState(result,'debug-blue').extensions!.debugBattle.replay
    expect(JSON.stringify(toPublicBattleState(result,'debug-blue'))).not.toContain('PRIVATE-INDICATOR-202')
    expect(archive.frames).toHaveLength(1)
    expect(hashStable(archive.initialState)).toBe(archive.initialCheckpointHash)
    const frame=archive.frames[0]
    expect(hashStable({...frame.postState,...(frame.inheritsMap?{map:archive.initialState.map}:{})})).toBe(frame.postCheckpointHash)
    expect(result.extensions!.skillPresentation.records).toHaveLength(1)
    const legacy=JSON.parse(JSON.stringify(result))
    legacy.extensions.debugBattle.replay.initialState.extensions ??= {}
    legacy.extensions.debugBattle.replay.initialState.extensions.skillPresentation=result.extensions!.skillPresentation
    expect(toPublicBattleState(legacy,'debug-blue').extensions!.debugBattle).not.toHaveProperty('replay')
    expect(legacy.extensions.debugBattle.replay.initialCheckpointHash).toBe(archive.initialCheckpointHash)
  })
  it('captures cue locations at emission and accepts only bundled sound presets',()=>{
    const state=fixture()
    api(state).emit({id:'sound',kind:'sound',sound:'success',targetId:'copy',text:'完成',audience:'public',lifetime:'battle'})
    state.pieces[1].x=3;state.pieces[1].currentHp=0
    expect(shown(state,'enemy').cues[0]).toMatchObject({x:1,y:0,sound:'success'})
    expect(()=>api(state).emit({id:'bad',kind:'sound',sound:'https://example.com/a.mp3',targetId:'source',text:'外链',audience:'public'} as any)).toThrow('sound')
  })
  it('binds display values without granting the mirrored HP, skills or statuses',()=>{
    const state=fixture(), original=JSON.stringify(state.pieces), flow=createSkillCodeFlow(state,{piece:state.pieces[0],skill:{id:'mirror'}},'skill')
    flow.presentation.bind({...bind,fields:[...bind.fields]})
    expect(JSON.stringify(state.pieces)).toBe(original)
    expect(shown(state,'enemy').bindings[0].display).toMatchObject({name:'本体',currentHp:7,statusTags:[{type:'divine-shield'}]})
    expect(JSON.stringify(shown(state,'enemy'))).not.toMatch(/sourceId|masterPieceId|"secret"|"source"/)
    state.pieces[0].currentHp=3; state.pieces[0].statusTags=[]
    expect(shown(state,'enemy').bindings[0].display).toMatchObject({currentHp:3,statusTags:[]})
    expect(state.pieces[1].currentHp).toBe(1)
  })
  it('preserves snapshots and explicit source-loss policies across serialization',()=>{
    const state=fixture(), presentation=api(state)
    for(const onSourceMissing of ['snapshot','self','remove'] as const) presentation.bind({...bind,id:onSourceMissing,fields:[...bind.fields],lifetime:'battle',onSourceMissing})
    presentation.bind({...bind,id:'frozen',fields:['health'],mode:'snapshot',lifetime:'battle'})
    state.pieces[0].currentHp=0
    const restored=JSON.parse(JSON.stringify(state))
    expect(shown(restored,'enemy').bindings.map((b:any)=>b.display.currentHp)).toEqual([7,1,7])
    expect(api(restored).remove('snapshot')).toBe(true)
    expect(api(restored).remove('snapshot')).toBe(false)
  })
  it('filters the entire presentation payload for owner, ally, enemy and anonymous/spectator identities',()=>{
    const state=fixture(), presentation=api(state)
    for(const audience of ['public','owner','allies','enemies','spectators'] as PresentationAudience[]) {
      presentation.indicator({id:audience,audience,targetId:'copy',label:audience,value:4})
      presentation.mark({id:'mark-'+audience,audience,cells:[{x:0,y:0}],label:audience,icon:'◆'})
      presentation.emit({id:'cue-'+audience,audience,targetId:'copy',text:audience,kind:'float'})
    }
    for(const [viewer,expected] of [['player-red',['public','owner','allies']],['ally',['public','allies']],['enemy',['public','enemies']],['observer',['public','spectators']],[undefined,['public','spectators']]] as const) {
      const result=shown(state,viewer)
      expect(result.indicators.map((i:any)=>i.label)).toEqual(expected)
      expect(result.markers.map((i:any)=>i.label)).toEqual(expected)
      expect(result.cues.map((i:any)=>i.text)).toEqual(expected)
      expect(result).not.toHaveProperty('records')
      expect(result).not.toHaveProperty('sequence')
    }
  })
  it('reads indicator values dynamically, expires records and cannot reserve a board cell',()=>{
    const state=fixture(), presentation=api(state), map=JSON.stringify(state.map)
    presentation.indicator({id:'hp',audience:'owner',targetId:'copy',label:'生命镜像',value:1,max:10,source:{pieceId:'source',field:'currentHp'}})
    presentation.mark({id:'cell',audience:'public',cells:[{x:1,y:0}],label:'预览',icon:'◆',expiresTurn:2})
    state.pieces[0].currentHp=5
    expect(shown(state,'player-red').indicators[0].value).toBe(5)
    expect(JSON.stringify(state.map)).toBe(map)
    expect(state.extensions?.tileEffects).toBeUndefined()
    state.turn.turnNumber=2
    expect(shown(state,'player-red').markers).toEqual([])
    state.pieces[0].currentHp=0
    expect(shown(state,'player-red').indicators).toEqual([])
    presentation.cleanup()
    expect(state.extensions!.skillPresentation.records).toEqual([])
  })
  it('invisible writes cannot change visible identifiers or evict another audience cue history',()=>{
    const one=fixture(),two=fixture()
    const publicCue={id:'public',audience:'public' as const,kind:'float' as const,targetId:'copy',text:'公开提示'}
    api(one).emit(publicCue)
    for(let i=0;i<100;i++) api(two).emit({...publicCue,id:'private-'+i,audience:'owner'})
    api(two).emit(publicCue)
    expect(shown(two,'enemy')).toEqual(shown(one,'enemy'))
    for(let i=100;i<210;i++) api(two).emit({...publicCue,id:'private-'+i,audience:'owner'})
    expect(shown(two,'enemy')).toEqual(shown(one,'enemy'))
    expect(shown(two,'enemy')).not.toHaveProperty('sequences')
  })
  it('deduplicates cue delivery keys and rejects invalid records before writing state',()=>{
    const state=fixture(), presentation=api(state)
    const cue={id:'one',kind:'float' as const,audience:'public' as const,targetId:'copy',text:'出现'}
    expect(presentation.emit(cue)).toBe(presentation.emit(cue))
    expect(shown(state,'enemy').cues).toHaveLength(1)
    const before=JSON.stringify(state)
    for(const bad of [{...cue,audience:'typo'},{...cue,text:''},{...cue,extra:true},{...cue,get text(){throw Error('getter invoked')}}]) expect(()=>presentation.emit(bad as any)).toThrow()
    expect(()=>presentation.bind({...bind,fields:['constructor']} as any)).toThrow()
    expect(()=>presentation.mark({id:'bad',audience:'public',cells:[{x:999,y:999}],icon:'◆',label:'bad'})).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })
  it('extends deferred selections while retaining authority descriptors and rejecting duplicate candidates',()=>{
    const state=fixture(), flow=createSkillCodeFlow(state,{piece:state.pieces[0]},'skill')
    const options={playerId:'player-red',targetType:'piece' as const,candidates:[{type:'piece',pieceId:'source'},{type:'piece',pieceId:'copy'}],selectionMode:'multi' as const,minSelections:1,maxSelections:2,effectCode:'function(ctx){return {success:true}}'}
    expect(flow.choice.deferTarget(options)).toMatchObject({selectionMode:'multi',minSelections:1,maxSelections:2,canCancel:true,needsTargetSelection:true})
    expect(()=>flow.choice.deferTarget({...options,candidates:[options.candidates[0],options.candidates[0]]})).toThrow('重复')
    expect(()=>flow.choice.deferTarget({...options,selectionMode:'single'})).toThrow('数量')
    expect(state.pendingTargetSelection).toBeUndefined()
  })
})
