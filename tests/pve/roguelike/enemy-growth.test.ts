import {beforeAll,describe,expect,it} from 'vitest'
import {createAdventureState,AdventureSession} from '@/lib/pve/roguelike/session'
import {createCooperativeAdventure,CooperativeAdventureSession} from '@/lib/pve/roguelike/cooperative-session'
import {adventureContent,HUMAN,ENEMY} from '@/lib/pve/roguelike/content'
import {upgradeWaitingEnemies,completedAdventureRounds} from '@/lib/pve/roguelike/enemies'
import {adventureBoundary} from '@/lib/game/adventure-boundary'
import {getServerGameProfileIdentityV1} from '@/lib/content-pipeline/runtime/profile-game-identity'
import type {BattleState} from '@/lib/game/turn'
let initial:BattleState
beforeAll(async()=>{initial=await createAdventureState(getServerGameProfileIdentityV1())})
describe('world enemy growth',()=>{
  it('upgrades after ten completed rounds, preserves wounds and never compounds repeated commands',()=>{
    const state=JSON.parse(JSON.stringify(initial)) as BattleState,enemy=state.pieces.find(p=>p.ownerPlayerId===ENEMY)!,ally=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    const base=enemy.maxHp,attack=enemy.attack,friend=structuredClone(ally)
    enemy.currentHp-=3
    state.turn.turnNumber=19
    expect(upgradeWaitingEnemies(state,adventureContent)).toBe(0)
    state.turn.turnNumber=21
    expect(completedAdventureRounds(state)).toBe(10)
    expect(upgradeWaitingEnemies(state,adventureContent)).toBeGreaterThan(0)
    expect(enemy.maxHp).toBe(Math.ceil(base*1.2));expect(enemy.currentHp).toBe(enemy.maxHp-3);expect(enemy.attack).toBe(attack+1)
    expect(upgradeWaitingEnemies(state,adventureContent)).toBe(0)
    const restored=JSON.parse(JSON.stringify(state)) as BattleState
    expect(upgradeWaitingEnemies(restored,adventureContent)).toBe(0)
    state.turn.turnNumber=41;upgradeWaitingEnemies(state,adventureContent)
    expect(enemy.maxHp).toBe(Math.ceil(base*1.4));expect(enemy.attack).toBe(attack+2)
    expect(ally).toEqual(friend)
  })
  it('freezes active encounters and never revives defeated enemies',()=>{
    const state=JSON.parse(JSON.stringify(initial)) as BattleState,w=adventureBoundary(state)!,zone=adventureContent.zones[0]
    w.activeZone=zone;w.activeEnemyIds=zone.enemyIds
    const active=state.pieces.filter(p=>zone.enemyIds.includes(p.instanceId)),before=structuredClone(active)
    const dead=state.pieces.find(p=>p.ownerPlayerId===ENEMY&&!zone.enemyIds.includes(p.instanceId))!;dead.currentHp=0
    const hp=dead.maxHp
    state.turn.turnNumber=41;upgradeWaitingEnemies(state,adventureContent)
    expect(active).toEqual(before);expect(dead.currentHp).toBe(0);expect(dead.maxHp).toBe(hp)
  })
  it('uses the shared cooperative round rather than each player turn',async()=>{
    const state=await createCooperativeAdventure(getServerGameProfileIdentityV1(),adventureContent,[{playerId:'a',name:'a',pieceIds:['tracer','ana']},{playerId:'b',name:'b',pieceIds:['tracer','ana']}])
    const w=adventureBoundary(state)!
    state.turn.turnNumber=99;w.coop!.round=10
    expect(upgradeWaitingEnemies(state,adventureContent)).toBe(0)
    w.coop!.round=11
    expect(upgradeWaitingEnemies(state,adventureContent)).toBeGreaterThan(0)
    expect(upgradeWaitingEnemies(state,adventureContent)).toBe(0)
  })
  it('applies growth through both authoritative commit paths',async()=>{
    const state=JSON.parse(JSON.stringify(initial)) as BattleState;state.turn.turnNumber=21
    const session=new AdventureSession(state),view=session.human({type:'beginPhase'},0)
    expect(Object.values(adventureBoundary(view.state)!.enemyLevels!).every(v=>v.level===1)).toBe(true)
    const coop=await createCooperativeAdventure(getServerGameProfileIdentityV1(),adventureContent,[{playerId:'a',name:'a',pieceIds:['tracer','ana']}])
    adventureBoundary(coop)!.coop!.round=11
    const shared=new CooperativeAdventureSession(coop,adventureContent,getServerGameProfileIdentityV1())
    const result=shared.human({type:'beginPhase'},0,'a')
    expect(Object.values(adventureBoundary(result.state)!.enemyLevels!).every(v=>v.level===1)).toBe(true)
  })
})
