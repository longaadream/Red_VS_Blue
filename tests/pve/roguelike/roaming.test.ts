import { describe, expect, it } from 'vitest'
import { adventureContent, HUMAN, ENEMY } from '@/lib/pve/roguelike/content'
import { AdventureSession, createAdventureState } from '@/lib/pve/roguelike/session'
import { initializeRoaming, planRoamingEnemies, tryStartRoamingEncounter } from '@/lib/pve/roguelike/roaming'
import { adventureBoundary, assertAdventurePosition } from '@/lib/game/adventure-boundary'
import { adventurePlanInvalidReason, planAdventureEnemies } from '@/lib/pve/roguelike/plans'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { runBattleActionIsolated } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import { loadAllSkillsById } from '@/lib/game/skills'
import type { BattleAction } from '@/lib/game/turn'

async function fixture() {
  const content = structuredClone(adventureContent)
  delete content.nextActs; delete content.generation
  content.map.layout = Array.from({ length: 24 }, (_, y) => y === 0 || y === 23 ? '#'.repeat(24) : '#' + '.'.repeat(22) + '#')
  content.zones = [{ id: 'fort', name: '远处据点', x: 15, y: 15, width: 8, height: 8,
    enemyIds: [`${ENEMY}-1`], coreIds: [`${ENEMY}-1`], reward: 25 }]
  content.sites = [{ id: 'camp', name: '营地', kind: 'camp', detail: '休整', x: 4, y: 6 }]
  content.enemyLineup = [
    { id: `${ENEMY}-1`, templateId: 'pve-reaper', zone: 'fort', tier: 'elite', role: '守卫', ip: '守望先锋', core: true, x: 18, y: 18 },
    { id: `${ENEMY}-2`, templateId: 'pve-zombie', zone: 'roaming', tier: 'minion', role: '追击', ip: '我的世界', core: false, x: 10, y: 5 },
  ]
  content.roaming = { enemyIds: [`${ENEMY}-2`], aggroRange: 8, reward: 8 }
  content.startingPositions = { [`${HUMAN}-1`]: { x: 5, y: 5 }, [`${HUMAN}-2`]: { x: 5, y: 6 },
    [`${ENEMY}-1`]: { x: 18, y: 18 }, [`${ENEMY}-2`]: { x: 10, y: 5 } }
  const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1(), content), { type: 'beginPhase' }).state
  initializeRoaming(state, content)
  return { state, content }
}

describe('roaming enemies on the exploration board', () => {
  it('publishes a deterministic native pursuit and executes it with zero enemy AP', async () => {
    const { state, content } = await fixture(), world = adventureBoundary(state)!
    const plans = planRoamingEnemies(state, content)
    expect(plans).toEqual(planRoamingEnemies(state, content)); expect(plans).toHaveLength(1)
    expect(plans[0].sourceId).toBe(`${ENEMY}-2`)
    world.plans = plans
    state.turn.currentPlayerId = ENEMY; state.turn.phase = 'action'
    state.players.find(p => p.playerId === ENEMY)!.actionPoints = 0
    const result = runBattleActionIsolated(state, plans[0].action).state
    expect(result.pieces.find(p => p.instanceId === plans[0].sourceId)).toMatchObject(plans[0].cells.at(-1)!)
    expect(result.players.find(p => p.playerId === ENEMY)!.actionPoints).toBe(0)
    expect(() => runBattleActionIsolated(state, { ...plans[0].action, toX: 11 } as BattleAction)).toThrow()
  })

  it('does not chase from outside aggro range and cancels an occupied published path', async () => {
    const { state, content } = await fixture()
    const enemy = state.pieces.find(p => p.instanceId === `${ENEMY}-2`)!
    enemy.x = 12; enemy.y = 10
    expect(planRoamingEnemies(state, content)).toEqual([])
    enemy.x = 10; enemy.y = 5
    const plans = planRoamingEnemies(state, content); adventureBoundary(state)!.plans = plans
    const captain = state.pieces.find(p => p.instanceId === `${HUMAN}-1`)!
    Object.assign(captain, plans[0].cells[0])
    expect(adventurePlanInvalidReason(state, plans[0])).toContain('占据')
  })

  it('starts a bounded local encounter on the human turn, never a free enemy opening attack', async () => {
    const { state, content } = await fixture()
    const foe = state.pieces.find(p => p.instanceId === `${ENEMY}-2`)!
    foe.x = 7
    state.turn.currentPlayerId = ENEMY
    expect(tryStartRoamingEncounter(state, content)).toBeUndefined()
    state.turn.currentPlayerId = HUMAN
    const encounter = tryStartRoamingEncounter(state, content)!
    expect(encounter).toMatchObject({ kind: 'roaming', width: 14, height: 14, reward: 8 })
    expect(encounter.enemyIds).toEqual([foe.instanceId])
    expect(() => assertAdventurePosition(state, state.pieces[0], 22, 5)).toThrow('封锁')
    expect(planRoamingEnemies(state, content)).toEqual([])
    expect(tryStartRoamingEncounter(state, content)).toBeUndefined()
  })

  it('awards a real native skill kill once, restores exploration and leaves the fixed outpost alive', async () => {
    const { state, content } = await fixture(), world = adventureBoundary(state)!
    const foe = state.pieces.find(p => p.instanceId === `${ENEMY}-2`)!
    foe.x = 7; foe.currentHp = 1
    tryStartRoamingEncounter(state, content)
    world.party!.battleRound = 1
    const ally = world.party!.reserves.shift()!
    ally.x = 6; ally.y = 5; state.pieces.push(ally)
    state.skillsById = loadAllSkillsById()
    const action: BattleAction = { type: 'useBasicSkill', playerId: HUMAN, pieceId: ally.instanceId, skillId: 'blessed-hammer' }
    const prepared = prepareAction(state, action)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') throw new Error('Missing target preparation')
    const session = new AdventureSession(state, content)
    const result = session.human({ ...action, targetPieceId: foe.instanceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction, 0)
    expect(result.world.coins).toBe(8)
    expect(result.world.lastReward).toMatchObject({ coins: 8, kind: 'roaming' })
    expect(result.world.active).toBeUndefined()
    expect(result.state.pieces.some(p => p.instanceId === `${ENEMY}-1` && p.currentHp > 0)).toBe(true)
    expect(result.state.players[0].actionPoints).toBe(3)
    expect(() => session.human(action, 0)).toThrow('过期')
    expect(session.snapshot().world.coins).toBe(8)
    expect(planRoamingEnemies(result.state, content)).toEqual([])
  })

  it('keeps a patrol ambush outside protected outposts even when the captain walks along their edge', async () => {
    const { state, content } = await fixture()
    const captain = state.pieces.find(p => p.instanceId === `${HUMAN}-1`)!
    const foe = state.pieces.find(p => p.instanceId === `${ENEMY}-2`)!
    captain.x = 13; captain.y = 13; foe.x = 15; foe.y = 13
    const area = tryStartRoamingEncounter(state, content)!
    expect(area).toBeDefined()
    for (const z of content.zones) expect(area.x + area.width <= z.x || z.x + z.width <= area.x || area.y + area.height <= z.y || z.y + z.height <= area.y).toBe(true)
    expect(area.enemyIds).not.toContain(`${ENEMY}-1`)
  })

  it('does not seal an encounter between two pieces separated by an impassable wall', async () => {
    const { state, content } = await fixture()
    state.pieces.find(p => p.instanceId === `${ENEMY}-2`)!.x = 7
    for (const tile of state.map.tiles.filter(t => t.x === 6)) tile.props.walkable = false
    expect(tryStartRoamingEncounter(state, content)).toBeUndefined()
  })

  it('announces a detour around a wall instead of stalling at a Manhattan local minimum', async () => {
    const { state } = await fixture(), world = adventureBoundary(state)!
    const source = state.pieces.find(p => p.instanceId === `${ENEMY}-2`)!
    source.x = 7; source.y = 5
    world.activeZone = { id: 'detour', x: 1, y: 1, width: 12, height: 12 }
    world.activeEnemyIds = [source.instanceId]; world.party!.battleRound = 1
    for (const tile of state.map.tiles.filter(t => t.x === 6 && t.y < 9)) tile.props.walkable = false
    const plan = planAdventureEnemies(state)[0]
    expect(plan.kind).toBe('move')
    expect(plan.cells.at(-1)!.y).toBeGreaterThan(5)
    expect(plan.cells.every(c => state.map.tiles.some(t => t.x === c.x && t.y === c.y && t.props.walkable))).toBe(true)
  })
})
