import {adventureBoundary} from '@/lib/game/adventure-boundary'
import { expect,it } from 'vitest'
import { CooperativeAdventureSession,createCooperativeAdventure } from '@/lib/pve/roguelike/cooperative-session'
import { createAdventureCheckpoint,restoreAdventureCheckpoint } from '@/lib/pve/roguelike/checkpoint'
import { adventureContent } from '@/lib/pve/roguelike/content'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

it('restores the complete aggregate and produces identical subsequent commands',async()=>{
  const profile=getServerGameProfileIdentityV1()
  const source=new CooperativeAdventureSession(await createCooperativeAdventure(profile,adventureContent,[{playerId:'save-player',name:'旅人',pieceIds:['tracer','uther']}]),adventureContent,profile)
  source.human({type:'beginPhase'},0,'save-player')
  const checkpoint=createAdventureCheckpoint(source),restored=restoreAdventureCheckpoint(checkpoint,profile)
  expect(createAdventureCheckpoint(restored).aggregate).toEqual(checkpoint.aggregate)
  expect(createAdventureCheckpoint(restored).hash).toBe(checkpoint.hash)
  const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value
  expect(createAdventureCheckpoint(restoreAdventureCheckpoint(reorder(checkpoint),profile)).hash).toBe(checkpoint.hash)
  const a=source.human({type:'endTurn',playerId:'save-player'},1,'save-player')
  const b=restored.human({type:'endTurn',playerId:'save-player'},1,'save-player')
  expect(a.state).toEqual(b.state)
  expect(createAdventureCheckpoint(source,false).hash).toBe(createAdventureCheckpoint(restored,false).hash)
  expect(()=>restoreAdventureCheckpoint({...checkpoint,schemaVersion:'rvb-pve-run-aggregate/v1'},profile)).toThrow()
  const corrupt=structuredClone(checkpoint);corrupt.aggregate.personal['save-player'].coins=500
  expect(()=>restoreAdventureCheckpoint(corrupt,profile)).toThrow('校验')
  expect(()=>restoreAdventureCheckpoint(checkpoint,{...profile,authorityContentHash:'a'.repeat(64)})).toThrow()
})


it('persists cross-act round offsets and enemy growth without upgrading again on restore',async()=>{
  const profile=getServerGameProfileIdentityV1(),state=await createCooperativeAdventure(profile,adventureContent,[{playerId:'save-player',name:'旅人',pieceIds:['tracer','ana']}])
  const world=adventureBoundary(state)!
  world.completedRoundOffset=10;world.coop!.round=11
  const source=new CooperativeAdventureSession(state,adventureContent,profile)
  source.human({type:'beginPhase'},0,'save-player')
  const before=source.snapshot().state.pieces.map(p=>({id:p.instanceId,hp:p.maxHp,attack:p.attack}))
  const restored=restoreAdventureCheckpoint(createAdventureCheckpoint(source),profile)
  const result=restored.human({type:'endTurn',playerId:'save-player'},restored.snapshot().revision,'save-player')
  expect(result.world.worldRound).toBe(21)
  expect(Object.values(adventureBoundary(result.state)!.enemyLevels!).every(v=>v.level===2)).toBe(true)
  expect(result.state.pieces.map(p=>({id:p.instanceId,hp:p.maxHp,attack:p.attack}))).toEqual(before)
})
