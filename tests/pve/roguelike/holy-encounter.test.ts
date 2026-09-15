import {expect,it} from 'vitest'
import {CooperativeAdventureSession,createCooperativeAdventure} from '@/lib/pve/roguelike/cooperative-session'
import {adventureContent} from '@/lib/pve/roguelike/content'
import {getServerGameProfileIdentityV1} from '@/lib/content-pipeline/runtime/profile-game-identity'
import {adventureBoundary,selectAdventureActor,insideZone} from '@/lib/game/adventure-boundary'
import {changePiecePositions} from '@/lib/game/position-change'
import {addCardToHandWithTriggers} from '@/lib/game/skills'

it.each(['holy-smite','holy-heal','holy-charge'])('guest %s affects only its current encounter',async cardId=>{
  const profile=getServerGameProfileIdentityV1(), content=structuredClone(adventureContent)
  const state=await createCooperativeAdventure(profile,content,[{playerId:'host',name:'Host',pieceIds:['uther']},{playerId:'guest',name:'Guest',pieceIds:['uther']}])
  const world=adventureBoundary(state)!, zone={...structuredClone(content.zones[0]),participants:['guest'],scaledPlayers:1,round:1,plans:[],plannedRound:1}
  const ally=state.pieces.find(p=>p.ownerPlayerId==='guest')!
  const cell=state.map.tiles.find(t=>t.props.walkable&&insideZone(zone,t.x,t.y)&&!state.pieces.some(p=>p.x===t.x&&p.y===t.y))!
  expect(changePiecePositions(state,[{pieceId:ally.instanceId,x:cell.x,y:cell.y}],'teleport').success).toBe(true)
  world.coop!.encounters[zone.id]=zone;world.coop!.playerZones.guest=zone.id
  selectAdventureActor(state,'guest',zone.id)
  state.turn.currentPlayerId='guest';state.turn.phase='action'
  ally.currentHp=2;ally.rules=[];ally.skills=[];state.pieces.find(p=>p.ownerPlayerId==='host')!.currentHp=1
  const player=state.players.find(p=>p.playerId==='guest')!;player.hand=[];player.actionPoints=10
  addCardToHandWithTriggers(state,cardId,'guest')
  const outside=state.pieces.filter(p=>!insideZone(zone,p.x,p.y)).map(p=>({id:p.instanceId,hp:p.currentHp,tags:structuredClone(p.statusTags)}))
  const beforeEnemyHp=state.pieces.filter(p=>zone.enemyIds.includes(p.instanceId)).reduce((n,p)=>n+p.currentHp,0)
  const session=new CooperativeAdventureSession(state,content,profile)
  const result=session.human({type:'playCard',playerId:'guest',cardInstanceId:player.hand[0].instanceId},session.currentRevision,'guest')
  expect(result.state.players.find(p=>p.playerId==='guest')!.actionPoints).toBe(9)
  expect(result.state.players.find(p=>p.playerId==='guest')!.hand.some(c=>c.cardId===cardId)).toBe(false)
  const afterAlly=result.state.pieces.find(p=>p.instanceId===ally.instanceId)!
  if(cardId==='holy-heal')expect(afterAlly.currentHp).toBe(10)
  if(cardId==='holy-charge')expect(afterAlly.statusTags.some(t=>t.id==='damage-buff')).toBe(true)
  if(cardId==='holy-smite')expect(result.state.pieces.filter(p=>zone.enemyIds.includes(p.instanceId)).reduce((n,p)=>n+p.currentHp,0)).toBe(beforeEnemyHp-5)
  for(const old of outside){const next=result.state.pieces.find(p=>p.instanceId===old.id)!;expect(next.currentHp).toBe(old.hp);expect(next.statusTags).toEqual(old.tags)}
},20000)
