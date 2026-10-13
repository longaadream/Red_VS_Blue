/* eslint-disable @typescript-eslint/no-explicit-any -- frozen full-state differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { createRuleExecutionContext, RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { TriggerSystem } from '@/lib/game/triggers'
import { buildWatcherUltimateGraph } from '@/scripts/migrate-semantic-watcher-ultimate'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/watcher-ultimate']
const migrated = applyGameplayModuleGraph(original, buildWatcherUltimateGraph())
function run(semantic: boolean, handSize: number, hasOwner: boolean) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.name = '观者'
    const battle: any = makeState({ pieces: [caster] })
    const player = battle.players.find((player: any) => player.playerId === 'player-red')
    player.hand = handSize < 0 ? undefined : Array.from({ length: handSize }, (_, index) => ({ cardId: 'watcher-calm', instanceId: 'existing-' + index }))
    if (!hasOwner) battle.players = battle.players.filter((player: any) => player.playerId !== 'player-red')
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}

function runWithOneTimeCardHooks(semantic = true) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.name = '观者'
    const battle: any = makeState({ pieces: [caster] })
    const player = battle.players.find((candidate: any) => candidate.playerId === 'player-red')
    player.hand = []
    let blockNext = true
    player.rules = [
      {
        id: 'watcher-block-once', name: '只阻止第一次加入', description: '', trigger: { type: 'beforeCardAdded' },
        effect: (state: any) => {
          state.extensions.beforeCardAddedAttempts = (state.extensions.beforeCardAddedAttempts ?? 0) + 1
          if (blockNext) { blockNext = false; return { success: true, blocked: true, messages: ['第一次加入被阻止'] } }
          return {}
        },
      },
      {
        id: 'watcher-consume-after-once', name: '只消费一次加入事件', description: '', trigger: { type: 'afterCardAdded' },
        limits: { maxUses: 1 },
        effect: (state: any, context: any) => {
          state.extensions.afterCardAddedConsumed = (state.extensions.afterCardAddedConsumed ?? 0) + 1
          const owner = state.players.find((candidate: any) => candidate.playerId === context.playerId)
          const index = owner?.hand?.findIndex((card: any) => card.instanceId === context.cardInstanceId) ?? -1
          if (owner && index >= 0) {
            const [removed] = owner.hand.splice(index, 1)
            owner.discardPile ??= []
            owner.discardPile.push(removed.cardId)
            state.extensions.afterCardAddedRemoved = (state.extensions.afterCardAddedRemoved ?? 0) + 1
          }
          return { success: true }
        },
      },
    ]
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}

function runWithPermanentCardBlock() {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.name = '观者'
    const battle: any = makeState({ pieces: [caster] })
    const player = battle.players.find((candidate: any) => candidate.playerId === 'player-red')
    player.chargePoints = 2
    let attempts = 0
    const triggerSystem = new TriggerSystem()
    triggerSystem.addRules([{
      id: 'watcher-block-forever', name: '永久阻止加入', description: '', trigger: { type: 'beforeCardAdded' },
      effect: () => {
        attempts += 1
        return { success: true, blocked: true, messages: ['永久阻止加入'] }
      },
    } as any])
    const definition: any = migrated
    battle.skillsById[definition.id] = definition
    const beforeHash = hashBattleState(battle)
    const diagnostics: any[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      if (args[0] === '[gameplay-module-diagnostic]') diagnostics.push(args[1])
    })
    const actionResult = runBattleAction(battle, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: definition.id,
    } as any, { rootSeed: 594, ruleExecutionContext: createRuleExecutionContext(triggerSystem) })
    consoleError.mockRestore()
    return { battle, attempts, beforeHash, actionResult, diagnostics, runtime: runtime.snapshot() }
  })
}
describe('semantic Watcher Ultimate', () => {
  for (const size of [-1, 0, 1, 2, 5, 8, 9, 10, 11]) for (const owner of [false, true]) {
    it(`preserves alternating generated cards and full-hand failure: size=${size}, owner=${owner}`, () => {
      const actual = run(true, size, owner)
      expect(actual).toEqual(run(false, size, owner))
      if (owner && size < 10) {
        const hand = actual.state.players.find((player: any) => player.playerId === 'player-red').hand
        expect(hand).toHaveLength(10)
        expect(hand.slice(Math.max(0, size)).map((card: any) => card.cardId)).toEqual(Array.from({ length: 10 - Math.max(0, size) }, (_, index) => index % 2 === 0 ? 'watcher-calm' : 'watcher-rage'))
      } else expect(actual.result.success).toBe(false)
    })
  }

  it('retries one real beforeCardAdded rejection and keeps afterCardAdded consumption bounded', () => {
    const actual = runWithOneTimeCardHooks()
    const legacy = runWithOneTimeCardHooks(false)
    const player = actual.state.players.find((candidate: any) => candidate.playerId === 'player-red')
    expect({ result: actual.result, state: actual.state }).toEqual({ result: legacy.result, state: legacy.state })
    expect(actual.result.success).toBe(true)
    expect(player.hand).toHaveLength(10)
    // The first calm attempt is rejected and the first accepted rage card is
    // removed by the after hook. Ten later accepted cards fill the hand.
    expect(player.hand.map((card: any) => card.cardId)).toEqual(Array.from({ length: 10 }, (_, index) => index % 2 === 0 ? 'watcher-calm' : 'watcher-rage'))
    expect(player.discardPile).toEqual(['watcher-rage'])
    expect(actual.state.extensions.beforeCardAddedAttempts).toBe(12)
    expect(actual.state.extensions.afterCardAddedConsumed).toBe(1)
    expect(actual.state.extensions.afterCardAddedRemoved).toBe(1)
  })

  it('isolates a permanent card block, bounds the loop, and runs the independent tail', () => {
    const actual = runWithPermanentCardBlock()
    expect(actual.attempts).toBe(256)
    expect(actual.battle.players[0].hand).toEqual([])
    expect(actual.battle.players[0].discardPile).toEqual([])
    expect(actual.battle.players[0].actionPoints).toBe(2)
    expect(actual.battle.players[0].chargePoints).toBe(2)
    expect(hashBattleState(actual.battle)).toBe(actual.beforeHash)
    expect(actual.actionResult.state.players[0]).toMatchObject({ actionPoints: 2, chargePoints: 0, hand: [], discardPile: [] })
    expect(actual.actionResult.state.actions).toEqual([
      expect.objectContaining({
        type: 'useChargeSkill',
        payload: expect.objectContaining({
          skillId: 'watcher-ultimate',
          chargeCost: 2,
          message: '观者使用了潦草急救（充能技能，消耗2点充能），观者释放潦草急救，手牌被平静(128)和暴怒(128)填满',
        }),
      }),
    ])
    expect(actual.diagnostics).toEqual([
      expect.objectContaining({
        statementId: 'fill-hand',
        message: 'gameplay while iteration budget exceeded: fill-hand',
        surface: 'skill',
        contentId: 'watcher-ultimate',
        actorPlayerId: 'player-red',
        turn: 1,
        phase: 'action',
        rootSeed: 594,
        actionId: expect.any(String),
        chainId: expect.any(String),
      }),
    ])
  })

  it('publishes an explicit finite safety ceiling for the card-fill loop', () => {
    const budget = buildWatcherUltimateGraph().body.find((entry: any) => entry.id === 'fill-hand') as any
    expect(budget.budget).toBe(256)
    expect(Number.isSafeInteger(budget.budget)).toBe(true)
  })
})
