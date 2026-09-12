import { describe, expect, it } from 'vitest'
import { AdventureSession, createAdventureState, type WorldProgress } from '@/lib/pve/roguelike/session'
import { adventureContent, HUMAN, ENEMY } from '@/lib/pve/roguelike/content'
import { campaignAct } from '@/lib/pve/roguelike/campaign'
import { adventureBoundary } from '@/lib/game/adventure-boundary'
import { adventureCards } from '@/lib/game/adventure-card-state'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { runBattleActionIsolated } from '@/lib/game/battle-runner'
import { RoguelikeAdventureV1Schema } from '@/lib/pve/contracts/roguelike-content-v1'
import type { BattleState } from '@/lib/game/turn'

function fixture() {
  const root = structuredClone(adventureContent)
  root.generation = undefined
  const first = { id: 'second-act', name: '第二幕', map: root.map, zones: root.zones, sites: root.sites,
    startingPositions: root.startingPositions, enemyLineup: root.enemyLineup, roaming: root.roaming }
  if (!first.sites.some(site => site.kind === 'exit')) first.sites.push({ id: 'exit', name: '入口', kind: 'exit', x: 1, y: 1, detail: '前往下一幕' })
  root.nextActs = [structuredClone(first)]
  return root
}
async function ready() {
  const content = fixture(), profile = getServerGameProfileIdentityV1()
  const state = runBattleActionIsolated(await createAdventureState(profile, content), { type: 'beginPhase' }).state
  const exit = content.sites.find(site => site.kind === 'exit')!
  const captain = state.pieces.find(piece => piece.ownerPlayerId === HUMAN)!
  captain.x = exit.x; captain.y = exit.y; captain.currentHp = 2
  const session = new AdventureSession(state, content, profile)
  const progress = (session as unknown as { progress: WorldProgress }).progress
  return { content, state: (session as unknown as { state: BattleState }).state, session, progress, exit, captain }
}
describe('adventure campaign authority', () => {
  it('validates every later act and keeps legacy one-act documents valid', () => {
    const content = fixture()
    expect(RoguelikeAdventureV1Schema.safeParse(content).success).toBe(true)
    content.nextActs![0].enemyLineup[0].templateId = 'not-registered'
    expect(RoguelikeAdventureV1Schema.safeParse(content).success).toBe(false)
    delete content.nextActs
    expect(RoguelikeAdventureV1Schema.safeParse(content).success).toBe(true)
  })
  it('cannot exit before defeating the act boss or while reward choice remains', async () => {
    const { session, progress, content, exit, captain, state } = await ready()
    await expect(session.advanceAct(exit.id, captain.instanceId, 0)).rejects.toThrow('首领')
    progress.cleared = content.zones.map(zone => zone.id)
    adventureCards(state)!.reward = { encounterId: 'pending', relicIds: [], cardIds: ['pve-skirmish-calibrated-shot'] }
    await expect(session.advanceAct(exit.id, captain.instanceId, 0)).rejects.toThrow('奖励')
    expect(session.snapshot().revision).toBe(0)
  })
  it('keeps the completed world-round count and applies growth across acts',async()=>{
    const {session,progress,content,exit,captain,state}=await ready()
    progress.cleared=content.zones.filter(z=>!z.optional).map(z=>z.id)
    state.turn.turnNumber=21
    const result=await session.advanceAct(exit.id,captain.instanceId,0)
    expect(result.world.worldRound).toBe(11)
    expect(adventureBoundary(result.state)?.completedRoundOffset).toBe(10)
    expect(Object.values(adventureBoundary(result.state)!.enemyLevels!).every(v=>v.level===1)).toBe(true)
  })
  it('keeps wounds, recruited identity, growth and coins; does not revive dead reserves', async () => {
    const { session, progress, content, exit, captain, state } = await ready()
    progress.cleared = content.zones.filter(zone => !zone.optional).map(zone => zone.id); progress.coins = 123
    const party = adventureBoundary(state)!.party!
    const dead = party.reserves.pop()!; dead.currentHp = 0; state.graveyard.push(dead)
    const recruit = { ...structuredClone(dead), instanceId: 'adventurer-recruit-test', currentHp: 3, attack: 8 }
    party.reserves.push(recruit); progress.recruited.push(structuredClone(recruit))
    adventureCards(state)!.players[HUMAN].growth.example = 7
    const player = state.players.find(item => item.playerId === HUMAN)!
    player.hand = [
      { cardId: 'pve-skirmish-calibrated-shot', instanceId: 'kept', ownerPlayerId: HUMAN, actionPointCost: 0,
        baseActionPointCost: 1, temporaryCostReductionTurnNumber: state.turn.turnNumber,
        contentState: { adventure: { lifetime: 'run', sourceId: 'reward' } } },
      { cardId: 'pve-skirmish-calibrated-shot', instanceId: 'temporary', ownerPlayerId: HUMAN, actionPointCost: 1,
        contentState: { adventure: { lifetime: 'encounter', sourceId: 'supply' } } },
    ]
    const result = await session.advanceAct(exit.id, captain.instanceId, 0)
    expect(result.world).toMatchObject({ actNumber: 2, actCount: 2, coins: 123, cleared: [], claimed: [] })
    expect(result.revision).toBe(1)
    expect(result.state.pieces.find(piece => piece.instanceId === captain.instanceId)?.currentHp).toBe(2)
    expect(result.deployment.pieces).toEqual([expect.objectContaining({ instanceId: recruit.instanceId, currentHp: 3, attack: 8 })])
    expect(result.world.cardProgress?.players[HUMAN].growth.example).toBe(7)
    expect(adventureBoundary(result.state)?.campaignHasNext).toBe(false)
    expect(result.state.players.find(item => item.playerId === HUMAN)!.hand).toEqual([
      expect.objectContaining({ instanceId: 'kept', actionPointCost: 1 }),
    ])
    expect(result.state.players.find(item => item.playerId === HUMAN)!.hand[0].temporaryCostReductionTurnNumber).toBeUndefined()
  })
  it('last enemy core on intermediate act does not terminate the run and still grants rewards', async () => {
    const { session, state, content } = await ready()
    const world = adventureBoundary(state)!, zone = content.zones.at(-1)!
    world.activeZone = zone; world.activeEnemyIds = zone.enemyIds
    const enemies = state.pieces.filter(piece => piece.ownerPlayerId === ENEMY)
    enemies.forEach(piece => { piece.currentHp = 0 })
    state.graveyard.push(...enemies); state.pieces = state.pieces.filter(piece => piece.ownerPlayerId !== ENEMY)
    const result = session.human({ type: 'endTurn', playerId: HUMAN }, 0)
    expect(result.state.terminalResult).toBeFalsy()
    expect(result.world.lastReward).toMatchObject({ id: zone.id, coins: zone.reward, kind: 'encounter' })
    expect(result.world.cardProgress?.reward?.encounterId).toBe(zone.id)
  })
  it('derives repeatable independent later-act layouts', () => {
    const source = fixture()
    expect(campaignAct(source, 1, 42)).toEqual(campaignAct(source, 1, 42))
    expect(campaignAct(source, 1, 42).party.seed).not.toBe(42)
    expect(source.party.seed).toBe(adventureContent.party.seed)
  })
  it('final act victory retains visible coins and allows the final reward choice', async () => {
    const content = fixture(); delete content.nextActs
    const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1(), content), { type: 'beginPhase' }).state
    const world = adventureBoundary(state)!, zone = content.zones.at(-1)!
    world.activeZone = zone; world.activeEnemyIds = zone.enemyIds
    const enemies = state.pieces.filter(piece => piece.ownerPlayerId === ENEMY)
    enemies.forEach(piece => { piece.currentHp = 0 })
    state.graveyard.push(...enemies); state.pieces = state.pieces.filter(piece => piece.ownerPlayerId !== ENEMY)
    const session = new AdventureSession(state, content)
    const result = session.human({ type: 'endTurn', playerId: HUMAN }, 0)
    expect(result.state.terminalResult?.winnerPlayerId).toBe(HUMAN)
    expect(result.world.coins).toBe(zone.reward + (content.roaming?.enemyIds.length ?? 0) * (content.roaming?.reward ?? 0))
    expect(result.world.lastReward?.coins).toBe(zone.reward)
    expect(result.world.cardProgress?.reward?.encounterId).toBe(zone.id)
  })
  it('awards each patrol death during exploration exactly once', async () => {
    const { session, state, content } = await ready()
    const id = content.roaming!.enemyIds[0]
    const enemy = state.pieces.find(piece => piece.instanceId === id)!
    enemy.currentHp = 0
    state.graveyard.push(enemy); state.pieces = state.pieces.filter(piece => piece.instanceId !== id)
    let result = session.human({ type: 'endTurn', playerId: HUMAN }, 0)
    expect(result.world.coins).toBe(content.roaming!.reward)
    expect(result.world.lastReward).toMatchObject({ kind: 'roaming', id: `kill:${id}` })
    result = result.inputOwner === HUMAN ? session.human({ type: 'beginPhase' }, result.revision) : session.step(result.revision)
    expect(result.world.coins).toBe(content.roaming!.reward)
    expect(result.world.claimed.filter(item => item === `kill:${id}`)).toHaveLength(1)
  })
  it('owns its state without writing campaign metadata into its caller', async () => {
    const state = await createAdventureState(getServerGameProfileIdentityV1(), fixture())
    const before = JSON.stringify(state), hp = state.pieces[0].currentHp
    const session = new AdventureSession(state, fixture())
    expect(JSON.stringify(state)).toBe(before)
    expect(adventureBoundary(session.snapshot().state)?.campaignHasNext).toBe(true)
    state.pieces[0].currentHp = 1
    expect(session.snapshot().state.pieces[0].currentHp).toBe(hp)
  })
  it('replaces an empty exploration plan with combat intentions on same-turn entry', async () => {
    const content = fixture(), zone = content.zones[0]
    const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1(), content), { type: 'beginPhase' }).state
    const captain = state.pieces.find(piece => piece.ownerPlayerId === HUMAN)!
    captain.x = zone.x - 1; captain.y = zone.y + 1
    const world = adventureBoundary(state)!
    world.plans = []; world.plansTurn = state.turn.turnNumber
    const session = new AdventureSession(state, content)
    const result = session.human({ type: 'move', playerId: HUMAN, pieceId: captain.instanceId, toX: zone.x, toY: zone.y + 1 }, 0)
    expect(result.world.active).toBe(zone.id)
    expect(result.world.plans.length).toBeGreaterThan(0)
    expect(result.world.plans.every(plan => plan.round === 1)).toBe(true)
  })
})
