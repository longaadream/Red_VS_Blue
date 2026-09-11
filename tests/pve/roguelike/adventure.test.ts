import { createAdventureState, AdventureSession, HUMAN, ENEMY, zones, createAdventureMap, startingPositions } from './fixtures/legacy-adventure'
import { describe, it, expect } from 'vitest'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { runBattleActionIsolated, hashBattleState } from '@/lib/game/battle-runner'
import { finalizeBattleTerminal } from '@/lib/game/terminal'
import { assertAdventurePosition, adventureBoundary, assertAdventureTransition } from '@/lib/game/adventure-boundary'
import { changePiecePositions } from '@/lib/game/position-change'
import { prepareAction } from '@/lib/game/targeting'
import { loadAllSkillsById } from '@/lib/game/skills'
import { safeCloneBattleState, type BattleAction, type BattleState } from '@/lib/game/turn'

async function fixture(deployedBoundaryFixture = true) {
  const initial = await createAdventureState(getServerGameProfileIdentityV1())
  // Existing boundary cases isolate skills on an already-deployed roster.
  if (deployedBoundaryFixture) {
    const world = adventureBoundary(initial)!
    for (const piece of world.party!.reserves) {
      Object.assign(piece, startingPositions[piece.instanceId as keyof typeof startingPositions]); initial.pieces.splice(1, 0, piece)
    }
    delete world.party
  }
  return runBattleActionIsolated(initial, { type: 'beginPhase' }).state
}
function targetAction(state: BattleState, pieceId: string, skillId: string, targetPieceId: string): BattleAction {
  state.skillsById = loadAllSkillsById()
  const base: BattleAction = { type: 'useBasicSkill', playerId: HUMAN, pieceId, skillId }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error('Expected native target preparation')
  return { ...base, targetPieceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction
}
describe('same-map adventure single-player slice', () => {
  it('initializes the real map and all original cores, with a traversable route to each site', async () => {
    const state = await fixture(false)
    expect([state.map.width, state.map.height]).toEqual([32,32])
    expect(state.pieces.filter(p => p.isCore).map(p => p.instanceId)).toEqual([`${HUMAN}-1`,`${ENEMY}-1`,`${ENEMY}-2`])
    expect(state.pieces.filter(p => !p.isCore)).toHaveLength(4)
    expect(state.pieces.filter(p => p.ownerPlayerId === HUMAN).map(p => p.instanceId)).toEqual([`${HUMAN}-1`])
    expect(adventureBoundary(state)?.party?.reserves.map(p => [p.instanceId,p.x,p.y])).toEqual([[`${HUMAN}-2`,null,null]])
    expect(state.deployment).toBeUndefined()
    expect(state.extensions?.debugBattle).toBeDefined()
    const map = createAdventureMap(), visited = new Set(['5,25']), queue = [[5,25]]
    for (let i=0;i<queue.length;i++) for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const [x,y]=[queue[i][0]+dx,queue[i][1]+dy], key=`${x},${y}`
      if (!visited.has(key) && map.tiles.some(t=>t.x===x&&t.y===y&&t.props.walkable)) { visited.add(key);queue.push([x,y]) }
    }
    expect(visited.has('10,24')).toBe(true);expect(visited.has('19,11')).toBe(true)
  })
  it('starts an encounter with an actual native move and prevents exiting without spending AP', async () => {
    const state = await fixture(); state.players[0].actionPoints=3
    const session = new AdventureSession(state)
    const result = session.human({type:'move',playerId:HUMAN,pieceId:`${HUMAN}-1`,toX:10,toY:25},0)
    expect(result.world.active).toBe('gate')
    expect(result.state.pieces[0].x).toBe(10)
    expect(result.legalMoves[`${HUMAN}-1`]).not.toContain('9,25')
    expect(result.legalMoves[`${HUMAN}-1`]).toContain('11,25')
    const before = session.snapshot()
    expect(()=>session.human({type:'move',playerId:HUMAN,pieceId:`${HUMAN}-1`,toX:9,toY:25},1)).toThrow('封锁')
    expect(session.snapshot()).toEqual(before)
    expect(()=>session.interact('camp','heal',`${HUMAN}-2`,1)).toThrow('封锁')
    expect(()=>session.human({type:'move',playerId:HUMAN,pieceId:`${HUMAN}-2`,toX:5,toY:25},1)).toThrow('支援')
  })
  it('rejects movement primitives, legacy relocations and damage into inactive regions', async () => {
    const state = await fixture(), world=adventureBoundary(state)!
    world.activeZone=zones[0];world.activeEnemyIds=[`${ENEMY}-1`]
    const piece=state.pieces[0];piece.x=10;piece.y=24
    expect(()=>changePiecePositions(state,[{pieceId:piece.instanceId,x:9,y:24}],'teleport')).toThrow('封锁')
    const moved=safeCloneBattleState(state);moved.pieces[0].x=9
    expect(()=>assertAdventureTransition(state,moved)).toThrow('封锁')
    const damaged=safeCloneBattleState(state);damaged.pieces[3].currentHp--
    expect(()=>assertAdventureTransition(state,damaged)).toThrow('跨区域')
    expect(()=>assertAdventurePosition(state,state.pieces[1],9,25)).not.toThrow()
  })
  it('rejects distant, repeated and stale searches; camp preserves the same map and spent loot', async () => {
    const state=await fixture(); state.players[0].actionPoints=3
    const remote=new AdventureSession(state)
    expect(()=>remote.interact('supply','search',`${HUMAN}-1`,0)).toThrow('相邻')
    state.pieces[0].x=7;state.pieces[0].y=24
    const session=new AdventureSession(state), found=session.interact('supply','search',`${HUMAN}-1`,0)
    expect(found.world.coins).toBe(15);expect(found.state.players[0].actionPoints).toBe(2)
    const before=session.snapshot()
    expect(()=>session.interact('supply','search',`${HUMAN}-1`,0)).toThrow('过期')
    expect(()=>session.interact('supply','search',`${HUMAN}-1`,1)).toThrow('搜过')
    expect(session.snapshot()).toEqual(before)
    const atCamp=await fixture();atCamp.pieces[0].currentHp=2
    const camping=new AdventureSession(atCamp), healed=camping.interact('camp','heal',`${HUMAN}-1`,0)
    expect(healed.state.pieces[0].currentHp).toBe(5)
    expect(healed.state.map).toEqual(atCamp.map)
    expect(healed.state.turn.phase).toBe('end')
  })
  it('clears an outpost through real skill damage, retaining wounds and the final core', async () => {
    const state=await fixture();state.players[0].actionPoints=3
    state.pieces[1].x=15;state.pieces[1].y=23;state.pieces[1].currentHp=9
    state.pieces[2].currentHp=1
    const world=adventureBoundary(state)!;world.activeZone=zones[0];world.activeEnemyIds=zones[0].enemyIds
    const action=targetAction(state,`${HUMAN}-2`,'blessed-hammer',`${ENEMY}-1`)
    const before=hashBattleState(state), session=new AdventureSession(state), result=session.human(action,0)
    expect(result.world.cleared).toEqual(['gate']);expect(result.world.coins).toBe(25)
    expect(result.world.active).toBeUndefined();expect(result.state.terminalResult).toBeUndefined()
    expect(result.state.pieces.find(p=>p.instanceId===`${HUMAN}-2`)?.currentHp).toBe(9)
    expect(result.state.pieces.some(p=>p.instanceId===`${ENEMY}-2`)).toBe(true)
    expect(hashBattleState(state)).toBe(before)
  })
  it('keeps formal core victory/defeat, exempts only adventure from the PVP round limit', async () => {
    const state=await fixture();state.turn.turnNumber=82;state.turn.phase='end'
    expect(finalizeBattleTerminal(state,{type:'endTurn',playerId:HUMAN})).toBeNull()
    const pvp=safeCloneBattleState(state);delete pvp.extensions!.adventureWorld
    expect(finalizeBattleTerminal(pvp,{type:'endTurn',playerId:HUMAN})?.reason).toBe('round-limit')
    const victory=await fixture();victory.pieces.filter(p=>p.ownerPlayerId===ENEMY).forEach(p=>p.currentHp=0)
    expect(finalizeBattleTerminal(victory,{type:'beginPhase'})?.winnerPlayerId).toBe(HUMAN)
    const defeat=await fixture();defeat.pieces.filter(p=>p.ownerPlayerId===HUMAN).forEach(p=>p.currentHp=0)
    expect(finalizeBattleTerminal(defeat,{type:'beginPhase'})?.winnerPlayerId).toBe(ENEMY)
  })
  it('does not admit debug commands or mutate snapshots', async () => {
    const state=await fixture(), session=new AdventureSession(state), before=session.snapshot()
    expect(()=>session.human({type:'grantChargePoints',playerId:HUMAN,amount:100} as BattleAction,0)).toThrow('管理')
    expect(()=>session.human({type:'endTurn',playerId:ENEMY},0)).toThrow('自己的')
    const view=session.snapshot();view.state.pieces[0].currentHp=0;view.world.claimed.push('supply')
    expect(session.snapshot()).toEqual(before)
  })
  it('lets outside support detour around the river and blocks the opposite direction', async () => {
    const state=await fixture(), world=adventureBoundary(state)!
    world.activeZone=zones[1];world.activeEnemyIds=zones[1].enemyIds
    const ally=state.pieces[1];ally.x=25;ally.y=17
    expect(()=>assertAdventurePosition(state,ally,24,17)).not.toThrow()
    expect(()=>assertAdventurePosition(state,ally,26,17)).toThrow('支援')
  })
  it('rejects real cross-boundary shields without spending resources', async () => {
    const state=await fixture();state.players[0].actionPoints=4
    state.pieces[0].x=9;state.pieces[0].y=23;state.pieces[1].x=10;state.pieces[1].y=23
    const world=adventureBoundary(state)!;world.activeZone=zones[0];world.activeEnemyIds=zones[0].enemyIds
    const command=targetAction(state,`${HUMAN}-2`,'shield-of-light',`${HUMAN}-1`)
    const session=new AdventureSession(state), before=session.snapshot()
    expect(()=>session.human(command,0)).toThrow('跨区域')
    expect(session.snapshot()).toEqual(before)
  })
  it('does not let an outside Tracer fire passive shots into a locked encounter', async () => {
    const state=await fixture();state.turn.currentPlayerId=ENEMY;state.players[1].actionPoints=2
    state.pieces[0].x=9;state.pieces[0].y=23;state.pieces[1].x=15;state.pieces[1].y=25
    state.pieces[2].x=10;state.pieces[2].y=23
    const world=adventureBoundary(state)!;world.activeZone=zones[0];world.activeEnemyIds=zones[0].enemyIds
    const result=runBattleActionIsolated(state,{type:'move',playerId:ENEMY,pieceId:`${ENEMY}-1`,toX:10,toY:22}).state
    expect(result.pieces.find(p=>p.instanceId===`${ENEMY}-1`)?.currentHp).toBe(state.pieces.find(p=>p.instanceId===`${ENEMY}-1`)!.currentHp)
  })
  it('removes real Recall data when the encounter is cleared', async () => {
    let state=await fixture();state.players[0].actionPoints=6;state.players[0].chargePoints=10
    state.pieces[0].x=14;state.pieces[0].y=23;state.pieces[1].x=15;state.pieces[1].y=23;state.pieces[2].currentHp=1
    const world=adventureBoundary(state)!;world.activeZone=zones[0];world.activeEnemyIds=zones[0].enemyIds
    state.skillsById=loadAllSkillsById()
    const recall: BattleAction={type:'useBasicSkill',playerId:HUMAN,pieceId:`${HUMAN}-1`,skillId:'recall'}
    const prepared=prepareAction(state,recall)
    if (prepared.kind !== 'needOption') throw new Error('Expected native Recall option')
    state=runBattleActionIsolated(state,{...recall,selectedOption:10,selectionId:prepared.selectionId,stateRevision:prepared.stateRevision} as BattleAction).state
    expect(state.extensions?.recallData?.length).toBe(1)
    const action=targetAction(state,`${HUMAN}-2`,'blessed-hammer',`${ENEMY}-1`)
    const result=new AdventureSession(state).human(action,0)
    expect(result.world.cleared).toEqual(['gate']);expect(result.state.extensions?.recallData).toBeUndefined()
  })
})
