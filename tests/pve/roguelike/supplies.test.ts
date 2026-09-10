import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAdventureState, AdventureSession } from '@/lib/pve/roguelike/session'
import { adventureSupplies, HUMAN, ENEMY, zones } from '@/lib/pve/roguelike/content'
import { grantAdventureCards, supplyEncounter, cleanupAdventureCards, offerAdventureRewards, chooseAdventureSupply } from '@/lib/pve/roguelike/supplies'
import { adventureCards } from '@/lib/game/adventure-card-state'
import { adventureBoundary } from '@/lib/game/adventure-boundary'
import { addCardToHandWithTriggers, dealDamage } from '@/lib/game/skills'
import { runBattleActionIsolated, hashBattleState } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { RoguelikeSuppliesV1Schema } from '@/lib/pve/contracts/roguelike-content-v1'
import type { BattleState, BattleAction } from '@/lib/game/turn'
import * as skills from '@/lib/game/skills'
import { getRuleMath } from '@/lib/game/rule-runtime'
import { globalTriggerSystem, type TriggerRule } from '@/lib/game/triggers'

afterEach(() => vi.restoreAllMocks())
function fixtureRule(trigger: string, effect: TriggerRule['effect']): TriggerRule {
  const rule = { id: 'supply-fixture', name: 'fixture', description: '', trigger: { type: trigger }, effect }
  const original = skills.loadRuleForBattle
  vi.spyOn(skills, 'loadRuleForBattle').mockImplementation((state, id, options) => id === rule.id ? { ...rule } : original(state, id, options))
  return JSON.parse(JSON.stringify(rule)) as TriggerRule
}

const config = adventureSupplies!
async function fixture() {
  const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1()), { type: 'beginPhase' }).state
  const world = adventureBoundary(state)!
  world.activeZone = zones[0]; world.activeEnemyIds = [...zones[0].enemyIds]
  const ally = state.pieces.find(p => p.ownerPlayerId === HUMAN)!, enemy = state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!
  ally.x = 11; ally.y = 24; ally.currentHp = ally.maxHp = 30; ally.defense = 0; ally.rules = []; ally.skills = []
  enemy.x = 12; enemy.y = 24; enemy.currentHp = enemy.maxHp = 100; enemy.defense = 0; enemy.rules = []; enemy.skills = []
  state.players[0].hand = []; state.players[0].actionPoints = 10
  return { state, ally, enemy }
}
function play(state: BattleState, cardId: string) {
  const card = state.players[0].hand.find(card => card.cardId === cardId)!
  const base: BattleAction = { type: 'playCard', playerId: HUMAN, cardInstanceId: card.instanceId }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(JSON.stringify(prepared))
  return runBattleActionIsolated(state, { ...base, targetPieceId: `${HUMAN}-1`, extraTargets: [{ pieceId: `${ENEMY}-1` }],
    selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }).state
}
describe('adventure supply and same-card growth', () => {
  it('publishes first-round enemy plans after supply hydrates and strips reserve rules', async () => {
    const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1()), {type:'beginPhase'}).state
    const world = adventureBoundary(state)!, captain = state.pieces.find(p => p.ownerPlayerId === HUMAN)!
    world.party!.reserves[0].rules = [JSON.parse(JSON.stringify(skills.loadRuleById('rule-divine-shield')!))]
    expect(world.party!.reserves.some(piece => piece.rules?.length)).toBe(true)
    captain.x = 9; captain.y = 24
    const view = new AdventureSession(state).human({type:'move',playerId:HUMAN,pieceId:captain.instanceId,toX:10,toY:24},0)
    expect(view.state.players[0].hand).toHaveLength(3)
    expect(view.world.plans.length).toBeGreaterThan(0)
    expect(view.state.extensions!.adventureWorld.plans).toEqual(view.world.plans)
    expect(view.state.extensions!.adventureWorld.plansTurn).toBe(view.state.turn.turnNumber)
  })
  it('grants each owned relic once per encounter with deterministic instance IDs', async () => {
    const { state } = await fixture(), other = structuredClone(state)
    supplyEncounter(state, HUMAN, 'gate', config); supplyEncounter(other, HUMAN, 'gate', config)
    expect(hashBattleState(state)).toBe(hashBattleState(other))
    expect(state.players[0].hand.map(c => c.cardId)).toEqual(['pve-skirmish-calibrate','pve-skirmish-calibrate','pve-skirmish-cover'])
    const before = hashBattleState(state)
    supplyEncounter(state, HUMAN, 'gate', config)
    expect(hashBattleState(state)).toBe(before)
  })
  it('retains earned unused cards and growth, but cleans temporary cards and encounter counters', async () => {
    const { state } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-light-spark',1,'run','reward')
    supplyEncounter(state,HUMAN,'gate',config)
    const ledger = adventureCards(state)!.players[HUMAN]
    ledger.growth['pve-light-spark'] = 8; ledger.passiveHits.enemy = 2
    cleanupAdventureCards(state)
    expect(state.players[0].hand.map(c => c.cardId)).toEqual(['pve-light-spark'])
    expect(ledger.growth).toEqual({'pve-light-spark':8}); expect(ledger.passiveHits).toEqual({})
    supplyEncounter(state,HUMAN,'keep',config)
    expect(state.players[0].hand).toHaveLength(4)
  })
  it('keeps the hand at ten and lets the player replace an old card or reject the incoming one', async () => {
    const { state } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-light-spark',10,'run','reward')
    grantAdventureCards(state,HUMAN,'pve-skirmish-cover',2,'encounter','relic')
    expect(state.players[0].hand).toHaveLength(10)
    const ledger = adventureCards(state)!.players[HUMAN], incoming = ledger.overflow[0]
    expect(ledger.overflow).toHaveLength(2)
    chooseAdventureSupply(state,HUMAN,'discard',state.players[0].hand[0].instanceId,config)
    expect(state.players[0].hand).toHaveLength(10)
    expect(state.players[0].hand.some(card => card.instanceId === incoming.instanceId)).toBe(true)
    chooseAdventureSupply(state,HUMAN,'discard',ledger.overflow[0].instanceId,config)
    expect(ledger.overflow).toHaveLength(0)
    expect(() => chooseAdventureSupply(state,HUMAN,'discard',state.players[0].hand[0].instanceId,config)).toThrow('没有')
  })
  it('blocks further actions while overflowing, rejects invalid or stale choices atomically', async () => {
    const { state } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-light-spark',10,'run','reward')
    grantAdventureCards(state,HUMAN,'pve-light-spark',1,'run','reward')
    const session = new AdventureSession(state), before = session.snapshot()
    expect(() => session.human({type:'endTurn',playerId:HUMAN},0)).toThrow('溢出')
    expect(() => session.supply('discard','forged',0)).toThrow('请选择')
    expect(session.snapshot()).toEqual(before)
    const id = adventureCards(state)!.players[HUMAN].overflow[0].instanceId
    session.supply('discard',id,0)
    expect(() => session.supply('discard',id,0)).toThrow('过期')
  })
  it('makes relic and card rewards independent, rejects repeat claims and activates new supply next encounter', async () => {
    const { state } = await fixture()
    offerAdventureRewards(state,HUMAN,'gate',config)
    chooseAdventureSupply(state,HUMAN,'relic','star-lantern',config)
    expect(() => chooseAdventureSupply(state,HUMAN,'relic','star-lantern',config)).toThrow('已经领取')
    chooseAdventureSupply(state,HUMAN,'cards','pve-light-spark',config)
    expect(adventureCards(state)!.reward).toBeUndefined()
    cleanupAdventureCards(state); supplyEncounter(state,HUMAN,'keep',config)
    expect(state.players[0].hand.filter(c => c.cardId === 'pve-light-spark')).toHaveLength(4)
  })
  it('grows later star-spark copies within the same fight and across encounters through native card actions', async () => {
    let { state } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-light-spark',2,'encounter','star-lantern')
    state = play(state,'pve-light-spark'); state = play(state,'pve-light-spark')
    expect(state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.currentHp).toBe(94)
    expect(adventureCards(state)!.players[HUMAN].growth['pve-light-spark']).toBe(4)
    cleanupAdventureCards(state); grantAdventureCards(state,HUMAN,'pve-light-spark',1,'encounter','star-lantern')
    state = play(state,'pve-light-spark')
    expect(state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.currentHp).toBe(88)
    expect(state.players[0].hand).toHaveLength(0)
  })
  it('only grows blood curse when actual life was paid', async () => {
    let { state } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-blood-curse',2,'encounter','blood-ledger')
    state = play(state,'pve-blood-curse'); state = play(state,'pve-blood-curse')
    expect(state.pieces[0].currentHp).toBe(28)
    expect(state.pieces.find(p => p.instanceId === `${ENEMY}-1`)!.currentHp).toBe(95)
    expect(adventureCards(state)!.players[HUMAN].growth['pve-blood-curse']).toBe(6)
  })
  it('counts a self-hit even when afterDamageTaken immediately heals it', async () => {
    const setup = await fixture(), { ally } = setup
    let { state } = setup
    ally.rules = [skills.loadRuleById('rule-ulquiorra-damage-taken')!]
    grantAdventureCards(state,HUMAN,'pve-blood-curse',1,'encounter','blood-ledger')
    state = play(state,'pve-blood-curse')
    expect(state.pieces.find(p => p.instanceId === ally.instanceId)!.currentHp).toBe(30)
    expect(adventureCards(state)!.players[HUMAN].growth['pve-blood-curse']).toBe(3)
  })
  it('does not grow blood curse or register passive hits through a divine shield', async () => {
    const setup = await fixture(), { ally, enemy } = setup
    let { state } = setup
    for (const piece of [ally, enemy]) {
      piece.statusTags = [{ id: 'divine-shield', type: 'divine-shield', intensity: 1 }]
      piece.rules = [skills.loadRuleById('rule-divine-shield')!]
    }
    dealDamage(ally,enemy,1,'physical',state,'pulse-pistol')
    expect(adventureCards(state)!.players[HUMAN].passiveHits[enemy.instanceId]).toBeUndefined()
    grantAdventureCards(state,HUMAN,'pve-blood-curse',1,'encounter','blood-ledger')
    state = play(state,'pve-blood-curse')
    expect(state.pieces.find(p => p.instanceId === ally.instanceId)!.currentHp).toBe(30)
    expect(adventureCards(state)!.players[HUMAN].growth['pve-blood-curse']).toBeUndefined()
  })
  it('isolates random supply triggers, restores JSON rules, and rolls back a failed retry', async () => {
    const { state } = await fixture()
    let reject = true
    state.players[0].rules = [fixtureRule('afterCardAdded', battle => {
      const draws = battle.extensions!.supplyDraws ??= []
      draws.push(getRuleMath().random())
      if (draws.length === 2 && reject) throw new Error('supply fixture rejection')
      return { success: true }
    })]
    offerAdventureRewards(state,HUMAN,'gate',config)
    const session = new AdventureSession(state), before = session.snapshot()
    const globalSnapshot = globalTriggerSystem.snapshotTransactionState()
    globalTriggerSystem.addRules([{ id: 'unrelated-room', name: '', description: '', trigger: { type: 'afterCardAdded' },
      effect: () => { throw new Error('Global registry must not run') } }])
    try {
      expect(() => session.supply('cards','pve-light-spark',0)).toThrow()
      expect(session.snapshot()).toEqual(before)
      reject = false
      const accepted = session.supply('cards','pve-light-spark',0)
      const repeated = new AdventureSession(state).supply('cards','pve-light-spark',0)
      expect(accepted.state.extensions!.supplyDraws).toHaveLength(2)
      expect(accepted).toEqual(repeated)
      expect(accepted.world.cardProgress!.supplyRuntime.cursors['skill/effect']).toBe(2)
      expect(globalTriggerSystem.getRules().some(rule => rule.id === 'unrelated-room')).toBe(true)
    } finally { globalTriggerSystem.restoreTransactionState(globalSnapshot) }
  })
  it('does not repeat beforeCardAdded when accepting a queued card', async () => {
    const { state } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-light-spark',10,'run','reward')
    state.players[0].rules = [fixtureRule('beforeCardAdded', battle => {
      battle.extensions!.additionCount = (battle.extensions!.additionCount ?? 0) + 1
      return { success: true }
    })]
    offerAdventureRewards(state,HUMAN,'gate',config)
    const session = new AdventureSession(state)
    const queued = session.supply('cards','pve-light-spark',0)
    expect(queued.state.extensions!.additionCount).toBe(2)
    const accepted = session.supply('discard',queued.state.players[0].hand[0].instanceId,1)
    expect(accepted.state.extensions!.additionCount).toBe(2)
    expect(accepted.state.players[0].hand).toHaveLength(10)
  })
  it('records actual allied passive hits, but not active or fully blocked damage, for calibration', async () => {
    let { state, ally, enemy } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-skirmish-calibrate',2,'encounter','calibration-magazine')
    state = play(state,'pve-skirmish-calibrate')
    expect(adventureCards(state)!.players[HUMAN].growth['pve-skirmish-calibrate']).toBeUndefined()
    ally = state.pieces.find(p => p.instanceId === ally.instanceId)!; enemy = state.pieces.find(p => p.instanceId === enemy.instanceId)!
    dealDamage(ally,enemy,1,'physical',state,'pulse-pistol')
    expect(adventureCards(state)!.players[HUMAN].passiveHits[enemy.instanceId]).toBe(1)
    state = play(state,'pve-skirmish-calibrate')
    expect(adventureCards(state)!.players[HUMAN].growth['pve-skirmish-calibrate']).toBe(3)
  })
  it('uses the selected ally as the authoritative origin for enemy range', async () => {
    const { state, ally, enemy } = await fixture()
    grantAdventureCards(state,HUMAN,'pve-light-spark',1,'run','reward')
    enemy.x = ally.x! + 4
    const base: BattleAction = {type:'playCard',playerId:HUMAN,cardInstanceId:state.players[0].hand[0].instanceId}
    const first = prepareAction(state, base)
    if (first.kind !== 'needTarget') throw new Error(JSON.stringify(first))
    const result = prepareAction(state,{...base,targetPieceId:ally.instanceId,selectionId:first.selectionId,stateRevision:first.stateRevision})
    expect(result.kind, JSON.stringify(result)).toBe('needTarget')
    if(result.kind==='needTarget') expect(result.candidates).not.toContainEqual({type:'piece',pieceId:enemy.instanceId})
    expect(() => play(state,'pve-light-spark')).toThrow()
    expect(state.players[0].hand).toHaveLength(1)
  })
  it('keeps standard PVP overflow behavior and rejects the PVE-only executable cards', async () => {
    const { state } = await fixture()
    delete state.extensions!.adventureWorld; delete state.extensions!.adventureCards; delete state.extensions!.contentMode
    state.players[0].hand = Array.from({length:10},(_,i)=>({cardId:'lucky-coin',instanceId:'old-'+i,ownerPlayerId:HUMAN}))
    expect(addCardToHandWithTriggers(state,'lucky-coin',HUMAN)).toBe(false)
    expect(state.players[0].hand).toHaveLength(10)
    expect(() => addCardToHandWithTriggers(state,'pve-light-spark',HUMAN)).toThrow('PVP')
  })
  it('validates declared supply IDs and counts strictly', () => {
    expect(() => RoguelikeSuppliesV1Schema.parse({...config,initialRelicIds:['missing']})).toThrow()
    const broken = JSON.parse(readFileSync('data/pve/roguelike/supplies.json','utf8'))
    broken.relics[0].grants[0].count = 0
    expect(() => RoguelikeSuppliesV1Schema.parse(broken)).toThrow()
  })
})
