import { describe, expect, it } from 'vitest'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { runBattleActionIsolated } from '@/lib/game/battle-runner'
import { adventureCards } from '@/lib/game/adventure-card-state'
import type { BattleAction } from '@/lib/game/turn'
import { createAdventureState } from '@/lib/pve/roguelike/session'
import { createFixedRoute, createFixedRouteBattleContent, loadFixedRouteMap } from '@/lib/pve/fixed-route/content'
import { createFixedRouteSession, RouteBattleSession } from '@/lib/pve/fixed-route/session'

const profile = getServerGameProfileIdentityV1()

describe('fixed route session', () => {
  it('starts at a between-node preview with the actual persistent roster', async () => {
    const session = await createFixedRouteSession(profile, 123)
    const snapshot = session.snapshot()

    expect(snapshot.revision).toBe(0)
    expect(snapshot.route).toMatchObject({
      seed: 123,
      chapterIndex: 0,
      chapterCount: 3,
      nodeIndex: 0,
      phase: 'between',
    })
    expect(snapshot.route.nodes.map(node => node.type)).toEqual([
      'battle', 'event', 'battle', 'shop', 'event', 'battle', 'boss',
    ])
    expect(snapshot.route.party.map(piece => piece.instanceId)).toEqual(['adventure-human-1', 'adventure-human-2'])
    expect(snapshot.state.map).toMatchObject({ width: 20, height: 16 })
    expect(snapshot.world.active).toBeUndefined()
  }, 30_000)

  it('rejects stale, wrong-stage, wrong-player, and debug actions atomically', async () => {
    const session = await createFixedRouteSession(profile, 123)
    const initial = session.snapshot()

    await expect(session.continue(initial.revision)).rejects.toThrow('请先进入当前战斗')
    expect(session.snapshot()).toEqual(initial)

    const entered = session.enter(initial.revision)
    expect(entered.route.phase).toBe('battle')
    expect(entered.revision).toBe(1)
    expect(entered.world.active).toBe(entered.route.nodes[0]!.encounterId)
    expect(entered.world.zones.find(zone => zone.id === entered.world.active)).toMatchObject({
      x: 0, y: 0, width: 20, height: 16,
    })

    const beforeErrors = session.snapshot()
    expect(() => session.enter(initial.revision)).toThrow('指令已过期')
    expect(session.snapshot()).toEqual(beforeErrors)
    await expect(session.continue(beforeErrors.revision)).rejects.toThrow('当前不能继续')
    expect(session.snapshot()).toEqual(beforeErrors)
    expect(() => session.step(beforeErrors.revision - 1)).toThrow('指令已过期')
    expect(session.snapshot()).toEqual(beforeErrors)
    expect(() => session.human({ type: 'endTurn', playerId: 'enemy' } as BattleAction, beforeErrors.revision))
      .toThrow('只能操作自己的队伍')
    expect(session.snapshot()).toEqual(beforeErrors)
    expect(() => session.human({ type: 'grantChargePoints', playerId: 'adventure-human', amount: 100 } as BattleAction, beforeErrors.revision))
      .toThrow('管理指令')
    expect(session.snapshot()).toEqual(beforeErrors)
  }, 30_000)

  it('runs a real enemy turn through the native step action', async () => {
    const session = await createFixedRouteSession(profile, 123)
    const entered = session.enter(0)
    const ended = session.human({ type: 'endTurn', playerId: entered.humanPlayerId }, entered.revision)
    const enemyTurn = session.human({ type: 'beginPhase' }, ended.revision)
    const beforeEnemy = enemyPieces(enemyTurn.state)
    const stepped = session.step(enemyTurn.revision)
    const afterEnemy = enemyPieces(stepped.state)

    expect(stepped.revision).toBe(enemyTurn.revision + 1)
    expect(afterEnemy).not.toEqual(beforeEnemy)
    expect(stepped.state.extensions?.debugBattle).toBeUndefined()
  }, 30_000)

  it('preserves wounds, run cards, relics, and progress while resetting encounter card costs', async () => {
    const first = await nativeBattle()
    first.battle.beginEncounter(0)
    const carry = first.battle.exportCarry()
    const captain = carry.pieces.find(piece => piece.instanceId === 'adventure-human-1')!
    captain.currentHp = Math.max(1, captain.currentHp - 1)
    const hand = carry.players.find(player => player.playerId === 'adventure-human')!.hand
    const card = hand[0]!
    const baseCost = card.actionPointCost
    card.contentState = { adventure: { lifetime: 'run', sourceId: 'fixed-route-test' } }
    card.baseActionPointCost = baseCost
    card.actionPointCost = 0
    card.temporaryCostReductionTurnNumber = 99
    const progress = first.battle.exportProgress()
    progress.coins = 37

    const second = await nativeBattle()
    second.battle.hydrateCarry(carry, progress)
    const hydrated = second.battle.exportCarry()
    const hydratedCaptain = hydrated.pieces.find(piece => piece.instanceId === captain.instanceId)!
    const hydratedCard = hydrated.players.find(player => player.playerId === 'adventure-human')!.hand.find(item => item.instanceId === card.instanceId)!
    const ledger = adventureCards(hydrated)!.players['adventure-human']

    expect(hydratedCaptain.currentHp).toBe(captain.currentHp)
    expect(hydratedCard.actionPointCost).toBe(baseCost)
    expect(hydratedCard.baseActionPointCost).toBeUndefined()
    expect(hydratedCard.temporaryCostReductionTurnNumber).toBeUndefined()
    expect(ledger.relicIds).toContain('calibration-magazine')
    expect(second.battle.exportProgress().coins).toBe(37)
  }, 30_000)

  it('turns a native surrender result into a route loss only after continue', async () => {
    const session = await createFixedRouteSession(profile, 123)
    const entered = session.enter(0)
    const result = session.human({ type: 'surrender', playerId: entered.humanPlayerId }, entered.revision)

    expect(result.route.phase).toBe('result')
    expect(result.route.lastResult).toMatchObject({ outcome: 'defeat', name: result.route.nodes[0]!.name })
    const lost = await session.continue(result.revision)
    expect(lost.route.phase).toBe('lost')
    expect(lost.revision).toBe(result.revision + 1)
  }, 30_000)
})

function enemyPieces(state: { pieces: Array<{ ownerPlayerId: string; instanceId: string; x: number | null; y: number | null; currentHp: number }> }) {
  return state.pieces
    .filter(piece => piece.ownerPlayerId === 'adventure-enemy')
    .map(piece => ({ id: piece.instanceId, x: piece.x, y: piece.y, hp: piece.currentHp }))
}

async function nativeBattle() {
  const route = createFixedRoute(123)
  const node = route.chapters[0]!.nodes[0]!
  const map = await loadFixedRouteMap(route.chapters[0]!.battles[node.encounterId!]!.mapId)
  const content = createFixedRouteBattleContent(route, 0, node, map)
  const initialized = await createAdventureState(profile, content, map)
  const preview = runBattleActionIsolated(initialized, { type: 'beginPhase' }, { rootSeed: route.seed }).state
  return { battle: new RouteBattleSession(preview, content, profile), content, map }
}
