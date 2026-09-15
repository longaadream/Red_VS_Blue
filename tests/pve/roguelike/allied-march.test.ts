import {it,expect} from 'vitest'
import {makeState,makePiece,makePlayer} from '../../helpers/minimal-state'
import {loadRuleById,addCardToHandWithTriggers} from '../../../lib/game/skills'
import {applyBattleAction} from '../../../lib/game/turn'
import {CooperativeAdventureSession,createCooperativeAdventure} from '../../../lib/pve/roguelike/cooperative-session'
import {adventureContent} from '../../../lib/pve/roguelike/content'
import {adventureBoundary,insideZone,selectAdventureActor} from '../../../lib/game/adventure-boundary'
import {getServerGameProfileIdentityV1} from '../../../lib/content-pipeline/runtime/profile-game-identity'
import {changePiecePositions} from '../../../lib/game/position-change'

it('2v2 march moves another owner through an ally, without granting ordinary control',()=>{
  const caster=makePiece({instanceId:'caster',templateId:'turalyon',ownerPlayerId:'red-a',x:0,y:0,rules:[loadRuleById('rule-turalyon-lightforged-march',true)!]})
  const mate=makePiece({instanceId:'mate',ownerPlayerId:'red-b',x:1,y:1,currentHp:5,maxHp:10})
  const blocker=makePiece({instanceId:'blocker',ownerPlayerId:'red-a',x:2,y:1})
  const state=makeState({pieces:[caster,mate,blocker],currentPlayerId:'red-a',width:8,height:8})
  state.players=[{...makePlayer('red-a','red'),teamId:'red'},{...makePlayer('red-b','red'),teamId:'red'},{...makePlayer('blue-a','blue'),teamId:'blue'},{...makePlayer('blue-b','blue'),teamId:'blue'}]
  expect(()=>applyBattleAction(state,{type:'move',playerId:'red-a',pieceId:'mate',toX:1,toY:2})).toThrow()
  addCardToHandWithTriggers(state,'holy-heal','red-a')
  let s=applyBattleAction(state,{type:'playCard',playerId:'red-a',cardInstanceId:state.players[0].hand[0].instanceId})
  let p=s.pendingTargetSelection!
  expect(p.candidates).toContainEqual({type:'piece',pieceId:'mate'})
  s=applyBattleAction(s,{type:'pendingTargetSelect',playerId:'red-a',targetPieceId:'mate',selectionId:p.selectionId,stateRevision:p.stateRevision})
  p=s.pendingTargetSelection!
  expect(p.candidates).toContainEqual({type:'cell',x:3,y:1})
  s=applyBattleAction(s,{type:'pendingTargetSelect',playerId:'red-a',targetX:3,targetY:1,selectionId:p.selectionId,stateRevision:p.stateRevision})
  expect(s.pieces.find(p=>p.instanceId==='mate')).toMatchObject({x:3,y:1,ownerPlayerId:'red-b'})
})

it('PVE march offers only legal encounter cells and moves a teammate',async()=>{
  const profile=getServerGameProfileIdentityV1(),content=structuredClone(adventureContent)
  const state=await createCooperativeAdventure(profile,content,[{playerId:'host',name:'host',pieceIds:['uther']},{playerId:'guest',name:'guest',pieceIds:['turalyon']}])
  const world=adventureBoundary(state)!,definition=content.zones[0]
  const cells=state.map.tiles.filter(t=>t.props.walkable&&insideZone(definition,t.x,t.y)&&!state.pieces.some(p=>p.currentHp>0&&p.x===t.x&&p.y===t.y))
  const pieces=['host','guest'].map(id=>state.pieces.find(p=>p.ownerPlayerId===id)!)
  expect(changePiecePositions(state,pieces.map((p,i)=>({pieceId:p.instanceId,x:cells[i].x,y:cells[i].y})),'teleport').success).toBe(true)
  const zone={...structuredClone(definition),participants:['host','guest'],scaledPlayers:2,round:1,plans:[],plannedRound:1}
  world.coop!.encounters[zone.id]=zone;world.coop!.playerZones={host:zone.id,guest:zone.id}
  selectAdventureActor(state,'guest',zone.id);state.turn.currentPlayerId='guest';state.turn.phase='action'
  state.players.find(p=>p.playerId==='guest')!.actionPoints=10
  addCardToHandWithTriggers(state,'holy-heal','guest')
  const session=new CooperativeAdventureSession(state,content,profile)
  let result=session.human({type:'playCard',playerId:'guest',cardInstanceId:state.players.find(p=>p.playerId==='guest')!.hand.find(c=>c.cardId==='holy-heal')!.instanceId},session.currentRevision,'guest')
  let pending=result.state.pendingTargetSelection!
  expect(pending.candidates).toContainEqual({type:'piece',pieceId:pieces[0].instanceId})
  result=session.human({type:'pendingTargetSelect',playerId:'guest',targetPieceId:pieces[0].instanceId,selectionId:pending.selectionId,stateRevision:pending.stateRevision},session.currentRevision,'guest')
  pending=result.state.pendingTargetSelection!
  const candidates=pending.candidates!.filter(c=>c.type==='cell')
  expect(candidates.length).toBeGreaterThan(0)
  expect(candidates.every(c=>insideZone(zone,c.x,c.y))).toBe(true)
  const target=candidates[0]
  result=session.human({type:'pendingTargetSelect',playerId:'guest',targetX:target.x,targetY:target.y,selectionId:pending.selectionId,stateRevision:pending.stateRevision},session.currentRevision,'guest')
  expect(result.state.pieces.find(p=>p.instanceId===pieces[0].instanceId)).toMatchObject({x:target.x,y:target.y,ownerPlayerId:'host'})
},20000)
