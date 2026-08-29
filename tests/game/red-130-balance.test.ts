/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored rules are exercised through runtime fixtures. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { dealDamage, loadCardById, loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')
const ROOT_SEED = 130

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

function loadSkill(id: string): SkillDefinition {
  return loadJson<SkillDefinition>('skills', `${id}.json`)
}

function installSkill(state: BattleState, piece: any, skillId: string): void {
  state.skillsById[skillId] = loadSkill(skillId)
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
}

function selectedPieceAction(
  state: BattleState,
  base: Record<string, unknown>,
  targetPieceId: string,
): BattleAction {
  const prepared = prepareAction(state, base as BattleAction)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return {
    ...base,
    targetPieceId,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as BattleAction
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-130 data contract', () => {
  it('publishes the approved curse coefficient and Itachi AP cost', () => {
    const curseRule = loadJson<{ description: string }>('rules', 'rule-rafaam-curse-ward.json')
    const curseSkill = loadSkill('rafaam-curse-ward')
    const amaterasu = loadSkill('itachi-amaterasu')

    expect(curseRule.description).toContain('50%')
    expect(curseSkill.description).toContain('50%')
    expect(amaterasu).toMatchObject({ actionPointCost: 2 })
  })

  it.each(['holy-smite', 'holy-heal', 'holy-charge'])('sets %s to 1 AP', cardId => {
    expect(loadCardById(cardId, true)).toMatchObject({ id: cardId, cardType: 'holy', actionPointCost: 1 })
  })
})

describe('RED-130 curse ward coefficient', () => {
  it('rounds half of odd current attack and freezes the curse without changing Rafaam', () => {
    const rafaam = makePiece({
      instanceId: 'rafaam', templateId: 'red-rafaam', ownerPlayerId: 'player-red', x: 0, y: 0,
      currentHp: 15, maxHp: 15, attack: 3,
    }) as any
    const enemy = makePiece({
      instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0,
    }) as any
    rafaam.name = 'Rafaam'
    rafaam.rules = [loadRuleById('rule-rafaam-curse-ward', true)!]
    const state = makeState({
      pieces: [rafaam, enemy], currentPlayerId: 'player-red', phase: 'action',
    }) as any

    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 1 }), () => {
      dealDamage(enemy, rafaam, 5, 'true', state, 'red-130-curse-hit')
    })

    const blue = state.players.find((player: any) => player.playerId === 'player-blue')
    const curse = blue.hand[0]
    const cardDef = state.customCards[curse.cardId]
    expect(rafaam).toMatchObject({ attack: 3, currentHp: 15 })
    expect(cardDef).toMatchObject({ damageAmount: 7, sourcePieceId: 'rafaam' })

    rafaam.attack = 9
    expect(cardDef.damageAmount).toBe(7)
  })
})

describe('RED-130 action-point settlement', () => {
  function itachiState(actionPoints: number) {
    const itachi = makePiece({
      instanceId: 'itachi', templateId: 'red-itachi', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    const target = makePiece({
      instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 0,
    }) as any
    itachi.name = 'Itachi'
    target.name = 'Target'
    const state = makeState({ pieces: [itachi, target], width: 6, height: 2 }) as any
    installSkill(state, itachi, 'itachi-amaterasu')
    state.players[0].actionPoints = actionPoints
    return { state, itachi, target }
  }

  it('charges 2 AP for Amaterasu Bind', () => {
    const { state } = itachiState(2)
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'itachi', skillId: 'itachi-amaterasu',
    }, 'target')

    const resolved = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    expect(resolved.players[0].actionPoints).toBe(0)
    expect(resolved.pieces.find(piece => piece.instanceId === 'itachi')?.skills[0].currentCooldown).toBe(2)
    expect(resolved.extensions?.amaterasuCells).toEqual([{ x: 3, y: 0 }])
    expect(resolved.pieces.find(piece => piece.instanceId === 'target')?.statusTags)
      .toContainEqual(expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 }))
  })

  it('rejects Amaterasu Bind at 1 AP without applying any partial state', () => {
    const { state, itachi, target } = itachiState(2)
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'itachi', skillId: 'itachi-amaterasu',
    }, 'target')
    state.players[0].actionPoints = 1
    const before = JSON.stringify(state)

    expect(() => runBattleAction(state, action, { rootSeed: ROOT_SEED })).toThrow(/Not enough action points/)
    expect(JSON.stringify(state)).toBe(before)
    expect(state.extensions?.amaterasuCells).toBeUndefined()
    expect(target.statusTags.some((tag: any) => tag.type === 'amaterasu-burn')).toBe(false)
    expect(itachi.skills[0].currentCooldown).toBe(0)
  })

  it.each(['holy-smite', 'holy-heal', 'holy-charge'])('charges exactly 1 AP to play %s', cardId => {
    const source = makePiece({ instanceId: `source-${cardId}`, ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    const ally = makePiece({
      instanceId: `ally-${cardId}`, ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 4, maxHp: 10,
    }) as any
    const enemy = makePiece({
      instanceId: `enemy-${cardId}`, ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0,
      currentHp: 20, maxHp: 20,
    }) as any
    const state = makeState({ pieces: [source, ally, enemy] }) as any
    const definition = loadCardById(cardId, true)!
    state.players[0].actionPoints = 1
    state.players[0].hand = [{
      cardId, instanceId: `card-${cardId}`, ownerPlayerId: 'player-red', actionPointCost: definition.actionPointCost,
    }]

    const resolved = runBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: `card-${cardId}`,
    } as BattleAction, { rootSeed: ROOT_SEED }).state
    expect(resolved.players[0]).toMatchObject({ actionPoints: 0, hand: [], discardPile: [cardId] })
  })

  it('rejects a holy card at 0 AP without removing it or applying its effect', () => {
    const source = makePiece({ instanceId: 'source-no-ap', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    const enemy = makePiece({
      instanceId: 'enemy-no-ap', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0,
      currentHp: 20, maxHp: 20,
    }) as any
    const state = makeState({ pieces: [source, enemy] }) as any
    state.players[0].actionPoints = 0
    state.players[0].hand = [{
      cardId: 'holy-smite', instanceId: 'holy-smite-no-ap', ownerPlayerId: 'player-red', actionPointCost: 1,
    }]
    const before = JSON.stringify(state)

    expect(() => runBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'holy-smite-no-ap',
    } as BattleAction, { rootSeed: ROOT_SEED })).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })
})
