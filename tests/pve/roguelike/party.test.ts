import { describe, it, expect } from 'vitest'
import { AdventureSession, createAdventureState } from '@/lib/pve/roguelike/session'
import { HUMAN, ENEMY, zones } from '@/lib/pve/roguelike/content'
import { adventureBoundary, adventureDeploymentCells } from '@/lib/game/adventure-boundary'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { runBattleActionIsolated } from '@/lib/game/battle-runner'
import { safeCloneBattleState, type BattleState, type BattleAction } from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'
import { loadAllSkillsById } from '@/lib/game/skills'
import { practiceEnvironment } from '@/lib/practice/environment'

const captainId = `${HUMAN}-1`, reserveId = `${HUMAN}-2`
async function exploration() {
  return runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1()), { type: 'beginPhase' }).state
}
function nextOwner(state: BattleState) {
  const ended = runBattleActionIsolated(state, { type: 'endTurn', playerId: state.turn.currentPlayerId }).state
  return runBattleActionIsolated(ended, { type: 'beginPhase' }).state
}
function command(session: AdventureSession, action: BattleAction) {
  return session.human(action, session.snapshot().revision)
}
function hammer(state: BattleState): BattleAction {
  state.skillsById = loadAllSkillsById()
  const base: BattleAction = { type: 'useBasicSkill', playerId: HUMAN, pieceId: reserveId, skillId: 'blessed-hammer' }
  const ready = prepareAction(state, base)
  if (ready.kind !== 'needTarget') throw Error('Expected hammer targeting')
  return { ...base, targetPieceId: `${ENEMY}-1`, selectionId: ready.selectionId, stateRevision: ready.stateRevision } as BattleAction
}
async function active() {
  const state = await exploration(), world = adventureBoundary(state)!
  // Keep the original real shotgun damage fixture independent of the new PVE enemy behaviour.
  state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.skills = [{skillId:'hellfire-shotgun',level:1}]
  const captain = state.pieces.find(p => p.instanceId === captainId)!
  captain.x = 14; captain.y = 23
  world.activeZone = zones[0]; world.activeEnemyIds = zones[0].enemyIds
  world.party!.anchor = { x: 14, y: 23 }; world.party!.battleRound = 1
  state.players[0].actionPoints = 1; state.players[0].maxActionPoints = 1
  return state
}

describe('captain exploration and encounter deployment', () => {
  it('shows only the captain and keeps exploration at 3 AP even after a long journey', async () => {
    const state = await exploration()
    expect(state.pieces.filter(p => p.ownerPlayerId === HUMAN).map(p => p.instanceId)).toEqual([captainId])
    expect(adventureBoundary(state)!.party!.reserves[0]).toMatchObject({ instanceId: reserveId, x: null, y: null, currentHp: 15 })
    expect(state.players[0].actionPoints).toBe(3)
    state.turn.turnNumber = 99; state.players[0].maxActionPoints = 10
    const next = nextOwner(nextOwner(state))
    expect(next.players[0]).toMatchObject({ actionPoints: 3, maxActionPoints: 3 })
    expect(adventureDeploymentCells(next)).toEqual([])
  })
  it('finishes the entry move with 1 AP and grows only the player encounter budget', async () => {
    const state = await exploration(); state.turn.turnNumber = 99; state.players[1].hand = []
    const session = new AdventureSession(state)
    const result = command(session, { type: 'move', playerId: HUMAN, pieceId: captainId, toX: 10, toY: 25 })
    expect(result.world.battleRound).toBe(1)
    expect(result.state.players[0]).toMatchObject({ actionPoints: 1, maxActionPoints: 1 })
    const enemyTurn = nextOwner(result.state)
    expect(enemyTurn.players[1].actionPoints).toBe(0)
    const secondRound = nextOwner(enemyTurn)
    expect(secondRound.players[0].actionPoints).toBe(2)
    expect(adventureBoundary(secondRound)!.party!.battleRound).toBe(2)
    adventureBoundary(secondRound)!.party!.battleRound = 10
    expect(nextOwner(nextOwner(secondRound)).players[0].actionPoints).toBe(10)
  })
  it('deploys through native summon for free, once per owner turn, and rejects bad/stale placements atomically', async () => {
    const state = await active(), party = adventureBoundary(state)!.party!
    state.players[1].hand = []
    party.reserves.push({ ...safeCloneBattleState(state).extensions!.adventureWorld.party.reserves[0], instanceId: `${HUMAN}-3` })
    const session = new AdventureSession(state), before = session.snapshot()
    expect(() => command(session, { type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: reserveId, toX: 18, toY: 23 })).toThrow()
    expect(session.snapshot()).toEqual(before)
    const deployed = command(session, { type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: reserveId, toX: 15, toY: 23 })
    expect(deployed.state.players[0].actionPoints).toBe(1)
    expect(deployed.state.pieces.find(p => p.instanceId === reserveId)).toMatchObject({ x: 15, y: 23, currentHp: 15 })
    expect(deployed.deployment.used).toBe(true)
    const after = session.snapshot()
    expect(() => command(session, { type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: `${HUMAN}-3`, toX: 14, toY: 24 })).toThrow()
    expect(() => session.human({ type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: reserveId, toX: 15, toY: 23 }, before.revision)).toThrow('过期')
    expect(session.snapshot()).toEqual(after)
    const later = nextOwner(nextOwner(after.state))
    const second = runBattleActionIsolated(later, { type: 'deployReservePiece', expectedDeploymentRevision: 1,
      playerId: HUMAN, pieceId: `${HUMAN}-3`, toX: 14, toY: 24 }).state
    expect(second.players[0].actionPoints).toBe(later.players[0].actionPoints)
    expect(second.pieces.some(p => p.instanceId === `${HUMAN}-3`)).toBe(true)
  })
  it('returns wounded allies to reserve on victory, then resets the next encounter to 1 AP', async () => {
    const state = await active(); state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.currentHp = 1
    adventureBoundary(state)!.party!.reserves[0].currentHp = 7
    const session = new AdventureSession(state)
    const deployed = command(session, { type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: reserveId, toX: 15, toY: 23 })
    const won = command(session, hammer(deployed.state))
    expect(won.world.cleared).toEqual(['gate'])
    expect(won.state.pieces.some(p=>p.instanceId===`${ENEMY}-5`)).toBe(true)
    expect(won.state.pieces.some(p=>p.instanceId===`${ENEMY}-3`)).toBe(false)
    expect(won.state.pieces.filter(p => p.ownerPlayerId === HUMAN).map(p => p.instanceId)).toEqual([captainId])
    expect(won.deployment.pieces[0]).toMatchObject({ instanceId: reserveId, currentHp: 7, x: null, y: null })
    expect(won.state.players[0].actionPoints).toBe(3)
    session.supply('skip-relic','',session.snapshot().revision)
    session.supply('skip-cards','',session.snapshot().revision)
    command(session, { type: 'move', playerId: HUMAN, pieceId: captainId, toX: 14, toY: 18 })
    command(session, { type: 'move', playerId: HUMAN, pieceId: captainId, toX: 14, toY: 13 })
    const next = command(session, { type: 'move', playerId: HUMAN, pieceId: captainId, toX: 19, toY: 13 })
    expect(next.world.active).toBe('keep'); expect(next.world.battleRound).toBe(1)
    expect(next.world.plans.length).toBeGreaterThan(0)
    expect(next.world.plans.every(p=>p.round===1&&p.id.startsWith('keep:'))).toBe(true)
    expect(next.state.players[0].actionPoints).toBe(1)
  })
  it('keeps a team alive with reserves after a real captain death, deploys at the death anchor and revives only after victory', async () => {
    let state = await active()
    state.pieces.find(p => p.instanceId === captainId)!.currentHp = 1
    state = nextOwner(state); state.players[1].actionPoints = 3
    const shot = practiceEnvironment.listLegalActions(state, ENEMY).find(c => c.action.type === 'useBasicSkill'
      && c.action.skillId === 'hellfire-shotgun' && c.action.targetX === 14 && c.action.targetY === 23)
    if (!shot) throw Error('Expected native shotgun candidate')
    state = runBattleActionIsolated(state, shot.action).state
    expect(state.pieces.some(p => p.instanceId === captainId && p.currentHp > 0)).toBe(false)
    expect(state.terminalResult).toBeUndefined()
    expect(adventureBoundary(state)!.party!.anchor).toEqual({ x: 14, y: 23 })
    state = nextOwner(state)
    state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.currentHp = 1
    const session = new AdventureSession(state)
    const deployed = command(session, { type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: reserveId, toX: 15, toY: 23 })
    const won = command(session, hammer(deployed.state))
    expect(won.state.pieces.find(p => p.instanceId === captainId)).toMatchObject({ currentHp: 1, x: 14, y: 23 })
    expect(won.state.graveyard.some(p => p.instanceId === captainId)).toBe(false)
    expect(won.deployment.pieces.map(p => p.instanceId)).toEqual([reserveId])
  })
  it('allows camp healing and upgrades for a wounded reserve member', async () => {
    const state = await active(); state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.currentHp = 1
    adventureBoundary(state)!.party!.reserves[0].currentHp = 7
    const session = new AdventureSession(state)
    const deployed = command(session, { type: 'deployReservePiece', expectedDeploymentRevision: 0, playerId: HUMAN, pieceId: reserveId, toX: 15, toY: 23 })
    command(session, hammer(deployed.state))
    session.supply('skip-relic', '', session.snapshot().revision)
    session.supply('skip-cards', '', session.snapshot().revision)
    for (const [toX,toY] of [[9,23],[5,23],[5,25]]) command(session, { type: 'move', playerId: HUMAN, pieceId: captainId, toX, toY })
    const attack = session.snapshot().deployment.pieces[0].attack
    const upgraded = session.interact('camp', 'attack', captainId, session.snapshot().revision, reserveId)
    expect(upgraded.world.coins).toBe(5)
    expect(upgraded.deployment.pieces[0]).toMatchObject({ attack: attack + 1, currentHp: 7 })
    for (let step = 0; step < 6; step++) {
      const view = session.snapshot()
      if (view.inputOwner === HUMAN && view.state.turn.phase === 'action') break
      if (view.inputOwner === ENEMY) session.step(view.revision)
      else command(session, { type: 'beginPhase' })
    }
    const healed = session.interact('camp', 'heal', captainId, session.snapshot().revision)
    expect(healed.deployment.pieces[0]).toMatchObject({ attack: attack + 1, currentHp: 13 })
  }, 15000) // This scenario executes setup plus a full encounter, travel and two camp transactions.
  it('loses normally when the captain dies with no surviving reserves', async () => {
    let state = await active()
    adventureBoundary(state)!.party!.reserves = []
    state.pieces.find(p => p.instanceId === captainId)!.currentHp = 1
    state = nextOwner(state); state.players[1].actionPoints = 3
    const shot = practiceEnvironment.listLegalActions(state, ENEMY).find(c => c.action.type === 'useBasicSkill'
      && c.action.skillId === 'hellfire-shotgun' && c.action.targetX === 14 && c.action.targetY === 23)!
    const ended = runBattleActionIsolated(state, shot.action).state
    expect(ended.terminalResult?.winnerPlayerId).toBe(ENEMY)
    expect(ended.pieces.some(p => p.instanceId === captainId && p.currentHp > 0)).toBe(false)
  })
})
