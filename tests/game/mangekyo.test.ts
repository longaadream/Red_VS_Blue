/* eslint-disable @typescript-eslint/no-explicit-any -- focused fixtures exercise JSON-authored skills and lifecycle state. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listLegalAIActions, observeBattleForAI } from '@/lib/game/ai-environment'
import { applyBattlePublicPatch, createBattlePublicPatch } from '@/lib/game/battle-public-patch'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { buildInitialPiecesForPlayers } from '@/lib/game/battle-setup'
import { toPublicBattleState } from '@/lib/game/deployment'
import type { BoardMap } from '@/lib/game/map'
import {
  getEffectiveChargeCost,
  getMangekyoDeathCount,
  MANGEKYO_KEYWORD,
} from '@/lib/game/mangekyo'
import { dealDamage, type SkillDefinition } from '@/lib/game/skills'
import { finalizeBattleTerminal } from '@/lib/game/terminal'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makeMap, makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')
const ROOT_SEED = 124

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

function makeBoardMap(): BoardMap {
  const map = makeMap()
  return {
    ...map,
    tiles: map.tiles.map(tile => ({
      id: `${map.id}-${tile.x}-${tile.y}`,
      x: tile.x,
      y: tile.y,
      props: {
        type: 'floor',
        walkable: tile.props.walkable,
        bulletPassable: true,
      },
    })),
  }
}

function activeSkill(id: string, overrides: Record<string, unknown> = {}): SkillDefinition {
  return {
    id,
    name: id,
    description: id,
    keywords: [],
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    targeting: { steps: [] },
    code: "function executeSkill(context) { context.battle.extensions.executed = context.skill.id; return { success: true, message: 'executed' }; }",
    ...overrides,
  } as SkillDefinition
}

function selectedAction(
  state: BattleState,
  base: Record<string, unknown>,
  targetPieceId: string,
): BattleAction {
  const prepared = prepareAction(state, base as BattleAction)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  const action = {
    ...base,
    targetPieceId,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as BattleAction
  expect(prepareAction(state, action)).toEqual({ kind: 'ready' })
  return action
}

function eventRule(id: string, type: string, effect: (battle: any, context: any) => void) {
  return {
    id,
    name: id,
    description: '',
    trigger: { type },
    effect: (battle: any, context: any) => {
      effect(battle, context)
      return { success: true }
    },
  }
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-124 Mangekyo data contract', () => {
  it('defines the keyword once and marks the three Uchiha ultimates with approved base costs', () => {
    const glossary = loadJson<Array<Record<string, unknown>>>('skill-keywords.json')
    expect(glossary.filter(entry => entry.name === MANGEKYO_KEYWORD)).toEqual([
      expect.objectContaining({
        id: 'mangekyo',
        name: '万花筒',
        shortDescription: '每次友方角色死亡时，该技能的充能消耗降低1，可降至0。',
        longDescription: '每当一个友方角色发生死亡结算，己方所有带有【万花筒】关键词的技能当前充能消耗永久降低1，最低为0。召唤物死亡会计算；同一角色复活后再次死亡也会再次计算。充能消耗降至0后，技能仍属于充能技能，并继续遵守行动点、冷却、目标和每局使用次数限制。',
      }),
    ])

    expect(loadJson<any>('skills', 'sasuke-susanoo.json')).toMatchObject({
      chargeCost: 2,
      description: '万花筒。激活完全体须佐能乎：攻击力+3，失去【千鸟】，获得【加具土命】与【因陀罗之矢】。',
      keywords: expect.arrayContaining([MANGEKYO_KEYWORD]),
    })
    expect(loadJson<any>('skills', 'itachi-totsuka-blade.json')).toMatchObject({
      chargeCost: 1,
      description: '万花筒。选择3格内的一个敌人，造成200%攻击力的魔法伤害，并使其所有主动技能进入2回合冷却。',
      keywords: expect.arrayContaining([MANGEKYO_KEYWORD]),
    })
    expect(loadJson<any>('skills', 'obito-space-time.json')).toMatchObject({
      name: '神威',
      type: 'ultimate',
      actionPointCost: 3,
      chargeCost: 3,
      description: '万花筒。选择地图上的一名敌方棋子，将其强制移出战场。该效果不造成伤害，也不视为死亡。每局限用一次。',
      keywords: expect.arrayContaining([MANGEKYO_KEYWORD]),
      targeting: { steps: [{ type: 'piece', filter: 'enemy', range: 99 }] },
    })

    const obito = loadJson<any>('pieces', 'red-obito.json')
    expect(obito.skills.map((entry: any) => entry.skillId)).toEqual([
      'obito-kamui',
      'obito-space-time',
      'hashirama-edo-wood-spike',
    ])
    expect(obito.rules).toEqual([])

    const mirror = { ...obito, id: 'obito-mirror', skills: [] }
    const randomValues = [0, 0.5]
    const pieces = buildInitialPiecesForPlayers(
      makeBoardMap(),
      ['player-red', 'player-blue'],
      [obito, mirror],
      [
        { playerId: 'player-red', pieces: [obito], faction: 'red' },
        { playerId: 'player-blue', pieces: [mirror], faction: 'blue' },
      ],
      () => randomValues.shift() ?? 0.75,
    )
    expect(pieces.find(piece => piece.templateId === 'red-obito')?.skills)
      .toContainEqual(expect.objectContaining({ skillId: 'obito-space-time', usesRemaining: 1 }))

    const battlePage = readFileSync(join(DATA_ROOT, 'pages', 'battle.html'), 'utf8')
    expect(battlePage).toContain("GameEngine.getEffectiveChargeCost(G, piece.ownerPlayerId, skillData)")
    expect(battlePage).toContain("currentCost + '/' + baseCost")
    expect(battlePage).toContain("const isCharge = skillUsesCharge(skData)")
  })
})

describe('RED-124 friendly death events', () => {
  it('counts summons and the same revived instance every time it dies', () => {
    const blueAttacker = makePiece({
      instanceId: 'blue-attacker', ownerPlayerId: 'player-blue', x: 0, y: 0,
    }) as any
    const redSummon = makePiece({
      instanceId: 'red-summon', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 5, maxHp: 5,
    }) as any
    redSummon.isCore = false
    const state = makeState({ pieces: [blueAttacker, redSummon] }) as any
    const mangekyoSkills = [
      loadJson<SkillDefinition>('skills', 'sasuke-susanoo.json'),
      loadJson<SkillDefinition>('skills', 'itachi-totsuka-blade.json'),
      loadJson<SkillDefinition>('skills', 'obito-space-time.json'),
    ]
    const nonMangekyo = activeSkill('ordinary-charge', { type: 'super', chargeCost: 3 })
    const costs = () => mangekyoSkills.map(skill =>
      getEffectiveChargeCost(state, 'player-red', skill))
    expect(costs()).toEqual([2, 1, 3])
    expect(getEffectiveChargeCost(state, 'player-red', nonMangekyo)).toBe(3)

    dealDamage(blueAttacker, redSummon, 5, 'true', state, 'first-death')
    expect(getMangekyoDeathCount(state, 'player-red')).toBe(1)
    expect(getMangekyoDeathCount(state, 'player-blue')).toBe(0)
    expect(costs()).toEqual([1, 0, 2])
    expect(getEffectiveChargeCost(state, 'player-red', nonMangekyo)).toBe(3)

    const revived = state.graveyard.pop()
    expect(revived?.instanceId).toBe(redSummon.instanceId)
    Object.assign(revived!, { currentHp: 5, x: 1, y: 0 })
    state.pieces.push(revived!)
    dealDamage(blueAttacker, revived!, 5, 'true', state, 'second-death')

    expect(getMangekyoDeathCount(state, 'player-red')).toBe(2)
    expect(costs()).toEqual([0, 0, 1])

    const revivedAgain = state.graveyard.pop()
    Object.assign(revivedAgain!, { currentHp: 5, x: 1, y: 0 })
    state.pieces.push(revivedAgain!)
    dealDamage(blueAttacker, revivedAgain!, 5, 'true', state, 'third-death')
    expect(getMangekyoDeathCount(state, 'player-red')).toBe(3)
    expect(costs()).toEqual([0, 0, 0])
  })

  it('counts the death event even when onPieceDied immediately revives the character', () => {
    const attacker = makePiece({
      instanceId: 'blue-attacker', ownerPlayerId: 'player-blue', x: 0, y: 0,
    }) as any
    const ally = makePiece({
      instanceId: 'red-ally', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 5, maxHp: 20,
    }) as any
    const state = makeState({ pieces: [attacker, ally] }) as any
    globalTriggerSystem.addRule(eventRule('revive-red-ally', 'onPieceDied', (_battle, context) => {
      context.sourcePiece.currentHp = 7
    }) as any)

    const result = dealDamage(attacker, ally, 5, 'true', state, 'revived-death')

    expect(result).toMatchObject({ isKilled: false, targetHp: 7 })
    expect(getMangekyoDeathCount(state, 'player-red')).toBe(1)
    expect(state.graveyard).toEqual([])
  })

  it('projects, patches, hashes, and logs the player death count deterministically', () => {
    const run = () => {
      const attacker = makePiece({
        instanceId: 'blue-attacker', ownerPlayerId: 'player-blue', x: 0, y: 0,
      }) as any
      const summon = makePiece({
        instanceId: 'red-summon', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 1, maxHp: 1,
      }) as any
      summon.isCore = false
      const state = makeState({ pieces: [attacker, summon] }) as any
      const publicBefore = toPublicBattleState(state, 'player-red')
      const hashBefore = hashBattleState(state)
      dealDamage(attacker, summon, 1, 'true', state, 'observable-death')
      return { state, publicBefore, hashBefore }
    }

    const first = run()
    const second = run()
    const publicAfter = toPublicBattleState(first.state, 'player-red')
    const patch = createBattlePublicPatch(first.publicBefore, publicAfter)

    expect(publicAfter.players[0].mangekyoDeathCount).toBe(1)
    expect(observeBattleForAI(first.state, 'player-red').players[0].mangekyoDeathCount).toBe(1)
    expect(applyBattlePublicPatch(first.publicBefore, JSON.parse(JSON.stringify(patch))))
      .toEqual(publicAfter)
    expect(hashBattleState(first.state)).not.toBe(first.hashBefore)
    expect(hashBattleState(second.state)).toBe(hashBattleState(first.state))
    expect(first.state.actions).toContainEqual(expect.objectContaining({
      type: 'mangekyoDeath',
      playerId: 'player-red',
      payload: expect.objectContaining({
        pieceId: 'red-summon',
        mangekyoDeathCount: 1,
      }),
    }))
  })
})

describe('RED-124 dynamic charge execution', () => {
  it('keeps a zero-cost Mangekyo skill on the charge-skill path for targeting, AI, payment, and logs', () => {
    const caster = makePiece({
      instanceId: 'mangekyo-caster', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    caster.skills = [{ skillId: 'zero-mangekyo', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [caster] }) as any
    state.players[0].mangekyoDeathCount = 2
    state.players[0].chargePoints = 0
    state.skillsById['zero-mangekyo'] = activeSkill('zero-mangekyo', {
      type: 'super',
      chargeCost: 2,
      keywords: [MANGEKYO_KEYWORD],
    })

    expect(getEffectiveChargeCost(state, 'player-red', state.skillsById['zero-mangekyo'])).toBe(0)
    expect(prepareAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: caster.instanceId,
      skillId: 'zero-mangekyo',
    })).toMatchObject({ kind: 'invalid' })
    expect(prepareAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: caster.instanceId,
      skillId: 'zero-mangekyo',
    })).toEqual({ kind: 'ready' })

    const candidate = listLegalAIActions(state, 'player-red').find(item =>
      item.action.type === 'useChargeSkill' && item.action.skillId === 'zero-mangekyo')
    expect(candidate?.kind).toBe('charge-skill')

    const next = runBattleAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: caster.instanceId,
      skillId: 'zero-mangekyo',
    }, { rootSeed: ROOT_SEED }).state
    expect(next.players[0].chargePoints).toBe(0)
    expect(next.actions).toContainEqual(expect.objectContaining({
      type: 'useChargeSkill',
      payload: expect.objectContaining({ skillId: 'zero-mangekyo', chargeCost: 0 }),
    }))
  })
})

describe('RED-124 Obito Kamui', () => {
  it('force-removes one global enemy without death/graveyard hooks and settles a removed core', () => {
    const redCore = makePiece({
      instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    redCore.isCore = true
    const obito = makePiece({
      instanceId: 'obito', templateId: 'red-obito', ownerPlayerId: 'player-red', x: 1, y: 0,
    }) as any
    obito.name = '宇智波带土'
    obito.skills = [{ skillId: 'obito-space-time', currentCooldown: 0, usesRemaining: 1 }]
    const blueCore = makePiece({
      instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 5, y: 4,
    }) as any
    blueCore.isCore = true
    const state = makeState({ pieces: [redCore, obito, blueCore] }) as any
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 3
    state.skillsById['obito-space-time'] = loadJson<SkillDefinition>('skills', 'obito-space-time.json')

    const action = selectedAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: obito.instanceId,
      skillId: 'obito-space-time',
    }, blueCore.instanceId)
    const next = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(next.pieces.some(piece => piece.instanceId === blueCore.instanceId)).toBe(false)
    expect(next.graveyard).toEqual([])
    expect(getMangekyoDeathCount(next, 'player-blue')).toBe(0)
    expect(next.extensions?.removedPieces).toEqual([
      expect.objectContaining({
        instanceId: blueCore.instanceId,
        ownerPlayerId: 'player-blue',
        isCore: true,
        removedBySkillId: 'obito-space-time',
      }),
    ])
    expect(next.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(next.pieces.find(piece => piece.instanceId === obito.instanceId)?.skills[0])
      .toMatchObject({ usesRemaining: 0 })
    expect(next.terminalResult ?? finalizeBattleTerminal(next, action, { actionIndex: 1 })).toMatchObject({
      winnerPlayerId: 'player-red',
      loserPlayerId: 'player-blue',
      reason: 'core-eliminated',
    })
  })
})
