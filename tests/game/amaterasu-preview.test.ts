import { beforeEach, describe, expect, it } from 'vitest'
import { makePiece, makeState } from '../helpers/minimal-state'
import { loadAllSkillsById } from '../../lib/game/skills'
import { prepareAction } from '../../lib/game/targeting'
import { previewBattleAction } from '../../lib/game/skill-preview'
import { createPublicRuleSource } from '../../lib/game/public-rule-source'
import { globalTriggerSystem } from '../../lib/game/triggers'
beforeEach(() => globalTriggerSystem.clearRules())
function fixture() {
  const state = makeState({width:8,height:6,pieces:[makePiece({instanceId:'sasuke',templateId:'red-sasuke',x:2,y:2,
    skills:[{skillId:'sasuke-amaterasu',currentCooldown:0,usesRemaining:-1}]})]})
  state.skillsById=loadAllSkillsById()
  state.players[0].actionPoints=10
  return state
}
describe('canonical Amaterasu terrain preview', () => {
  it('shows nine predicted terrain cells without mutating authority', () => {
    const state=fixture()
    const draft={type:'useBasicSkill',playerId:'player-red',pieceId:'sasuke',skillId:'sasuke-amaterasu'} as const
    const preparation=prepareAction(state,draft)
    if(preparation.kind!=='needTarget')throw Error('missing target')
    const before=JSON.stringify(state)
    const result=previewBattleAction(state,{...draft,targetX:3,targetY:3,selectionId:preparation.selectionId,stateRevision:preparation.stateRevision},'player-red')
    expect(result.status).toBe('ready')
    if(result.status!=='ready')throw Error(result.status)
    expect(result.snapshot.extensions?.tileEffects).toHaveLength(9)
    expect(result.snapshot.extensions?.tileEffects).toEqual(expect.arrayContaining([expect.objectContaining({x:3,y:3,tileType:'amaterasu'})]))
    expect(JSON.stringify(state)).toBe(before)
  })
  it.each(['player-blue','missing-holder'])('rejects new rules with unproven source %s', sourceId => {
    const state=fixture()
    const source=createPublicRuleSource(state,'player-red')
    expect(source.ruleResolver?.(state,'rule-sasuke-amaterasu-move',{sourceId})).toBeNull()
    expect(source.hasUnsupportedAccess()).toBe(true)
  })
})
