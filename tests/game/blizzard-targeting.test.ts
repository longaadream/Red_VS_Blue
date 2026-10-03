import { beforeEach, describe, expect, it } from 'vitest'
import { runBattleAction } from '../../lib/game/battle-runner'
import { loadAllSkillsById } from '../../lib/game/skills'
import { prepareAction } from '../../lib/game/targeting'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function fixture() {
  const state = makeState({width:20,height:16,pieces:[
    makePiece({instanceId:'jaina',templateId:'jaina',x:0,y:0,attack:4,
      skills:[{skillId:'blizzard',currentCooldown:0,usesRemaining:3}]}),
    makePiece({instanceId:'enemy',ownerPlayerId:'player-blue',x:19,y:14}),
  ]})
  state.skillsById=loadAllSkillsById()
  state.players[0].chargePoints=4
  return state
}
const action={type:'useChargeSkill',playerId:'player-red',pieceId:'jaina',skillId:'blizzard'} as const
beforeEach(()=>globalTriggerSystem.clearRules())
describe('RED-239 Blizzard full-map targeting',()=>{
  it('offers every map cell including targets more than seven cells away',()=>{
    const prepared=prepareAction(fixture(),action)
    expect(prepared.kind).toBe('needTarget')
    if(prepared.kind!=='needTarget') throw new Error('target prompt missing')
    expect(prepared.candidates).toHaveLength(320)
    expect(prepared.candidates).toContainEqual({type:'cell',x:19,y:15})
  })
  it('casts at a distant center while preserving the seven by seven effect area',()=>{
    const state=fixture();const prepared=prepareAction(state,action)
    if(prepared.kind!=='needTarget') throw new Error('target prompt missing')
    const next=runBattleAction(state,{...action,targetX:10,targetY:10,
      selectionId:prepared.selectionId,stateRevision:prepared.stateRevision},{rootSeed:239}).state
    expect(next.players[0].chargePoints).toBe(2)
    expect(next.players[0].statusTags).toEqual(expect.arrayContaining([expect.objectContaining({type:'blizzard',centerX:10,centerY:10})]))
    const tiles=next.extensions?.tileEffects?.filter((tile: {tileType:string;x:number;y:number})=>tile.tileType==='blizzard')
    expect(tiles).toHaveLength(49)
    expect(tiles?.every((tile: {x:number;y:number})=>Math.abs(tile.x-10)<=3&&Math.abs(tile.y-10)<=3)).toBe(true)
  })
  it('rejects a cell outside the map without altering the input state',()=>{
    const state=fixture();const before=JSON.stringify(state);const prepared=prepareAction(state,action)
    if(prepared.kind!=='needTarget') throw new Error('target prompt missing')
    expect(()=>runBattleAction(state,{...action,targetX:20,targetY:15,
      selectionId:prepared.selectionId,stateRevision:prepared.stateRevision},{rootSeed:239})).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })
})

