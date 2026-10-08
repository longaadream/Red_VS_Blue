import {beforeEach,describe,expect,it} from 'vitest'
import {prepareAction} from '../../lib/game/targeting'
import {preparePublicSkillAction,previewBattleAction} from '../../lib/game/skill-preview'
import {loadAllSkillsById} from '../../lib/game/skills'
import {PracticeSession} from '../../lib/practice/session'
import {runBattleAction} from '../../lib/game/battle-runner'
import {globalTriggerSystem} from '../../lib/game/triggers'
import {makePiece,makeState} from '../helpers/minimal-state'
function fixture(){
 const state=makeState({width:8,height:6,pieces:[
  makePiece({instanceId:'minato',templateId:'blue-minato',x:1,y:1,skills:[{skillId:'minato-kunai-formula',currentCooldown:0,usesRemaining:-1}]}),
  makePiece({instanceId:'ally',x:2,y:1}),makePiece({instanceId:'enemy',ownerPlayerId:'player-blue',x:7,y:5})]})
 state.skillsById=loadAllSkillsById()
 state.map.tiles.find(tile=>tile.x===4&&tile.y===4)!.props.walkable=false
 state.extensions!.minatoAnchors=[{x:4,y:3,sourceId:'minato',ownerPlayerId:'player-red'},
  {x:5,y:3,sourceId:'other-minato',ownerPlayerId:'player-red'},
  {x:4,y:4,sourceId:'minato',ownerPlayerId:'player-red'},
  {x:7,y:5,sourceId:'minato',ownerPlayerId:'player-red'}]
 const draft={type:'useBasicSkill',playerId:'player-red',pieceId:'minato',skillId:'minato-kunai-formula'} as const
 const root=prepareAction(state,draft);if(root.kind!=='needTarget')throw new Error('missing root prompt')
 const selected={...draft,targetPieceId:'ally',selectionId:root.selectionId,stateRevision:root.stateRevision}
 return {state,selected}
}
beforeEach(()=>globalTriggerSystem.clearRules())
describe('RED-238 visible Minato anchor target',()=>{
 it('keeps the second public target candidates equal to canonical targeting',()=>{
  const {state,selected}=fixture();const before=JSON.stringify(state)
  const canonical=prepareAction(state,selected);if(canonical.kind!=='needTarget')throw new Error('missing cell prompt')
  expect(canonical.candidates).toEqual([{type:'cell',x:4,y:3}])
  const visible=preparePublicSkillAction(state,selected,'player-red')
  expect(visible.status).toBe('needs-input')
  if(visible.status!=='needs-input')throw new Error('missing public target prompt')
  expect(visible.preparation).toMatchObject({kind:'needTarget',targetType:'cell',candidates:canonical.candidates,canCancel:true})
  expect(JSON.stringify(state)).toBe(before)
 })
 it('previews and submits a legal ally teleport with one AP and one anchor consumed',()=>{
  const {state,selected}=fixture();const action={...selected,extraTargets:[{x:4,y:3}]}
  expect(previewBattleAction(state,action,'player-red').status).toBe('ready')
  const next=runBattleAction(state,action,{rootSeed:238}).state
  expect(next.pieces.find(piece=>piece.instanceId==='ally')).toMatchObject({x:4,y:3})
  expect(next.players[0].actionPoints).toBe(1)
  expect(next.extensions?.minatoAnchors).not.toEqual(expect.arrayContaining([expect.objectContaining({x:4,y:3,sourceId:'minato'})]))
  expect(next.pieces.find(piece=>piece.instanceId==='ally')?.statusTags).toEqual(expect.arrayContaining([expect.objectContaining({type:'flying-raijin-mark',sourceId:'minato'})]))
 })
 it('continues filtering owner-only anchors before public preparation',()=>{
  const {state,selected}=fixture()
  state.extensions!.minatoAnchors.push({x:6,y:3,sourceId:'minato',ownerPlayerId:'player-blue',projectionVisibility:'owner'})
  const visible=preparePublicSkillAction(state,selected,'player-red')
  if(visible.status!=='needs-input')throw new Error('missing public target prompt')
  expect(visible.preparation).toMatchObject({kind:'needTarget',candidates:[{type:'cell',x:4,y:3}]})
 })
 it('accepts an anchor on the selected ally cell and legacy anchors without an owner field',()=>{
  const {state,selected}=fixture()
  state.extensions!.minatoAnchors=[{x:2,y:1,sourceId:'minato'},{x:4,y:3,sourceId:'minato'}]
  const visible=preparePublicSkillAction(state,selected,'player-red')
  if(visible.status!=='needs-input')throw new Error('missing public target prompt')
  expect(visible.preparation).toMatchObject({kind:'needTarget',candidates:[{type:'cell',x:2,y:1},{type:'cell',x:4,y:3}]})
 })
 it('submits the public second target through the normal practice session',()=>{
  const {state}=fixture()
  state.players[0].playerId='practice-human';state.players[1].playerId='practice-ai'
  state.turn.currentPlayerId='practice-human'
  state.pieces.forEach(piece=>{piece.ownerPlayerId=piece.ownerPlayerId==='player-red'?'practice-human':'practice-ai'})
  state.extensions!.minatoAnchors.forEach((entry:{ownerPlayerId:string})=>{entry.ownerPlayerId='practice-human'})
  const draft={type:'useBasicSkill',playerId:'practice-human',pieceId:'minato',skillId:'minato-kunai-formula'} as const
  const root=prepareAction(state,draft);if(root.kind!=='needTarget')throw new Error('missing practice root')
  const selected={...draft,targetPieceId:'ally',selectionId:root.selectionId,stateRevision:root.stateRevision}
  const publicSecond=preparePublicSkillAction(state,selected,'practice-human')
  if(publicSecond.status!=='needs-input')throw new Error('missing practice public target prompt')
  expect(publicSecond.preparation).toMatchObject({kind:'needTarget',candidates:[{type:'cell',x:4,y:3}]})
  const session=new PracticeSession(state,238)
  const result=session.human({...selected,extraTargets:[{x:4,y:3}]},0)
  expect(result.state.pieces.find(piece=>piece.instanceId==='ally')).toMatchObject({x:4,y:3})
  expect(result.state.players[0].actionPoints).toBe(1)
  expect(result.revision).toBe(1)
  expect(result.state.pendingTargetSelection).toBeUndefined()
 })
 it.each([{x:5,y:3},{x:4,y:4},{x:7,y:5},{x:3,y:3}])('rejects an invalid anchor %j without altering input',(cell)=>{
  const {state,selected}=fixture();const before=JSON.stringify(state)
  expect(()=>runBattleAction(state,{...selected,extraTargets:[cell]},{rootSeed:238})).toThrow()
  expect(JSON.stringify(state)).toBe(before)
 })
})
