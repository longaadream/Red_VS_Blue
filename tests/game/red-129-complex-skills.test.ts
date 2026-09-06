/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise JSON-authored RED-129 skills. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { dealDamage, loadAllSkillsById } from '@/lib/game/skills'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 1292

function namedPiece(overrides: Parameters<typeof makePiece>[0], name: string) {
  const piece = makePiece(overrides) as any
  piece.name = name
  return piece
}

function installSkill(state: BattleState, piece: any, skillId: string) {
  const skill = loadAllSkillsById()[skillId]
  if (!skill) throw new Error(`${skillId} did not load`)
  state.skillsById[skillId] = skill
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
  return skill
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

function selectedGridAction(
  state: BattleState,
  base: Record<string, unknown>,
  targetX: number,
  targetY: number,
): BattleAction {
  const prepared = prepareAction(state, base as BattleAction)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  expect(prepared.candidates.map(targetRefKey)).toContain(`cell:${targetX},${targetY}`)
  return {
    ...base,
    targetX,
    targetY,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as BattleAction
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-129 authoritative complex skill behavior', () => {
  it('excludes Ana herself, buffs one other ally, and adds one damage to every target', () => {
    const ana = namedPiece({
      instanceId: 'ana',
      templateId: 'ana',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
    }, '安娜')
    const ally = namedPiece({
      instanceId: 'ally',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 0,
      attack: 4,
      moveRange: 3,
    }, '友军')
    const first = namedPiece({
      instanceId: 'first',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 0,
      currentHp: 20,
      maxHp: 20,
    }, '敌人一')
    const second = namedPiece({
      instanceId: 'second',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 20,
      maxHp: 20,
    }, '敌人二')
    const state = makeState({
      pieces: [ana, ally, first, second],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 8,
      height: 5,
    }) as any
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 2
    installSkill(state, ana, 'nano-boost')
    const draft = {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'ana',
      skillId: 'nano-boost',
    } as const
    const prepared = prepareAction(state, draft)
    if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
    expect(prepared.candidates.map(targetRefKey)).toContain('piece:ally')
    expect(prepared.candidates.map(targetRefKey)).not.toContain('piece:ana')

    const boosted = runBattleAction(state, {
      ...draft,
      targetPieceId: 'ally',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    }, { rootSeed: ROOT_SEED }).state
    const boostedAlly = boosted.pieces.find(piece => piece.instanceId === 'ally')!

    expect(boosted.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(boostedAlly).toMatchObject({ defense: 3, moveRange: 4 })
    expect(boostedAlly.statusTags).toContainEqual(expect.objectContaining({ type: 'nano-boost' }))

    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 2 }), () => {
      const firstTarget = boosted.pieces.find(piece => piece.instanceId === 'first')!
      for (const damageType of ['physical', 'magical', 'true'] as const) {
        firstTarget.currentHp = 20
        dealDamage(boostedAlly, firstTarget, 4, damageType, boosted, `nano-${damageType}-probe`)
        expect(firstTarget.currentHp, damageType).toBe(15)
      }

      firstTarget.currentHp = 20
      dealDamage(
        boostedAlly,
        boosted.pieces.filter(piece => piece.instanceId === 'first' || piece.instanceId === 'second'),
        4,
        'true',
        boosted,
        'nano-batch-probe',
      )
    })
    expect(boosted.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(15)
    expect(boosted.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(15)
  })

  it('applies the 9/7/4/4 Holy Light rings and ignores distance four', () => {
    const anduin = namedPiece({
      instanceId: 'anduin',
      templateId: 'anduin',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
    }, '安度因')
    const centerEnemy = namedPiece({
      instanceId: 'center-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 3,
      currentHp: 20,
      maxHp: 20,
    }, '中心敌人')
    const ringOneAlly = namedPiece({
      instanceId: 'ring-one-ally',
      ownerPlayerId: 'player-red',
      x: 3,
      y: 4,
      currentHp: 10,
      maxHp: 20,
    }, '一环友军')
    const ringTwoEnemy = namedPiece({
      instanceId: 'ring-two-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 5,
      currentHp: 20,
      maxHp: 20,
    }, '二环敌人')
    const ringThreeAlly = namedPiece({
      instanceId: 'ring-three-ally',
      ownerPlayerId: 'player-red',
      x: 3,
      y: 0,
      currentHp: 10,
      maxHp: 20,
    }, '三环友军')
    const ringFourEnemy = namedPiece({
      instanceId: 'ring-four-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 7,
      y: 3,
      currentHp: 20,
      maxHp: 20,
    }, '四环敌人')
    const state = makeState({
      pieces: [anduin, centerEnemy, ringOneAlly, ringTwoEnemy, ringThreeAlly, ringFourEnemy],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 8,
      height: 7,
    }) as any
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 1
    installSkill(state, anduin, 'holy-light-descend')
    const action = selectedGridAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'anduin',
      skillId: 'holy-light-descend',
    }, 3, 3)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === 'center-enemy')?.currentHp).toBe(11)
    expect(result.pieces.find(piece => piece.instanceId === 'ring-one-ally')?.currentHp).toBe(17)
    expect(result.pieces.find(piece => piece.instanceId === 'ring-two-enemy')?.currentHp).toBe(16)
    expect(result.pieces.find(piece => piece.instanceId === 'ring-three-ally')?.currentHp).toBe(14)
    expect(result.pieces.find(piece => piece.instanceId === 'ring-four-enemy')?.currentHp).toBe(20)
    expect(result.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
  })

  it('grants exactly one immediate Frostmourne charge and still drops the victim crystal', () => {
    const arthas = namedPiece({
      instanceId: 'arthas',
      templateId: 'arthas',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      attack: 4,
    }, '阿尔萨斯')
    const enemy = namedPiece({
      instanceId: 'enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 8,
      maxHp: 8,
    }, '敌人')
    enemy.isCore = true
    const state = makeState({
      pieces: [arthas, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
    }) as any
    state.players[0].actionPoints = 1
    state.players[0].chargePoints = 0
    installSkill(state, arthas, 'arthas-frostmourne')
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'arthas',
      skillId: 'arthas-frostmourne',
    }, 'enemy')
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.graveyard.some(piece => piece.instanceId === 'enemy')).toBe(true)
    expect(result.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 1 })
    expect(result.extensions?.tileEffects).toContainEqual(expect.objectContaining({
      tileType: 'charge-crystal', sourceId: 'enemy', x: 2, y: 1,
    }))
  })

  it('lets Kenshin cross the whole map, lands beside the target, deals 200% true damage, and refunds 1 AP on kill', () => {
    const kenshin = namedPiece({
      instanceId: 'kenshin',
      templateId: 'blue-kenshin',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      attack: 4,
    }, '绯村剑心')
    const enemy = namedPiece({
      instanceId: 'enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 10,
      y: 5,
      currentHp: 8,
      maxHp: 8,
    }, '敌人')
    enemy.defense = 99
    const state = makeState({
      pieces: [kenshin, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 12,
      height: 7,
    }) as any
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 2
    installSkill(state, kenshin, 'kenshin-amakakeru')
    const action = selectedPieceAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'kenshin',
      skillId: 'kenshin-amakakeru',
    }, 'enemy')
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const moved = result.pieces.find(piece => piece.instanceId === 'kenshin')!

    expect(result.graveyard.some(piece => piece.instanceId === 'enemy')).toBe(true)
    expect(moved).toMatchObject({ x: 10, y: 4 })
    expect(result.players[0].actionPoints).toBe(1)
  })

  it('deals Kiljaedan 200% damage once to the target and every other enemy in its 3x3 area', () => {
    const kiljaedan = namedPiece({
      instanceId: 'kiljaedan',
      templateId: 'kiljaedan',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      attack: 4,
    }, '基尔加丹')
    const main = namedPiece({
      instanceId: 'main',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 2,
      currentHp: 20,
      maxHp: 20,
    }, '主目标')
    const splash = namedPiece({
      instanceId: 'splash',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 3,
      currentHp: 20,
      maxHp: 20,
    }, '溅射目标')
    const outside = namedPiece({
      instanceId: 'outside',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 4,
      y: 4,
      currentHp: 20,
      maxHp: 20,
    }, '范围外敌人')
    const ally = namedPiece({
      instanceId: 'ally',
      ownerPlayerId: 'player-red',
      x: 2,
      y: 3,
      currentHp: 20,
      maxHp: 20,
    }, '友军')
    const state = makeState({
      pieces: [kiljaedan, main, splash, outside, ally],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 6,
    }) as any
    state.players[0].actionPoints = 2
    installSkill(state, kiljaedan, 'kiljaedan-fel-fire')
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'kiljaedan',
      skillId: 'kiljaedan-fel-fire',
    }, 'main')
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === 'main')?.currentHp).toBe(12)
    expect(result.pieces.find(piece => piece.instanceId === 'splash')?.currentHp).toBe(12)
    expect(result.pieces.find(piece => piece.instanceId === 'outside')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'ally')?.currentHp).toBe(20)
  })

  it('stops Rocket Punch before the first enemy and damages no piece behind it', () => {
    const doomfist = namedPiece({
      instanceId: 'doomfist',
      templateId: 'red-doomsday-fist',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 1,
      attack: 3,
    }, '末日铁拳')
    const first = namedPiece({
      instanceId: 'first',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 1,
      currentHp: 20,
      maxHp: 20,
    }, '首个敌人')
    const behind = namedPiece({
      instanceId: 'behind',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 4,
      y: 1,
      currentHp: 20,
      maxHp: 20,
    }, '后方敌人')
    const state = makeState({
      pieces: [doomfist, first, behind],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 4,
    }) as any
    state.players[0].actionPoints = 2
    installSkill(state, doomfist, 'rocket-punch')
    const action = selectedGridAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'doomfist',
      skillId: 'rocket-punch',
    }, 5, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === 'doomfist')).toMatchObject({ x: 2, y: 1 })
    expect(result.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(14)
    expect(result.pieces.find(piece => piece.instanceId === 'behind')?.currentHp).toBe(20)
  })

  it('lands Earthshatter on an empty cell and damages only enemies in the centered 3x3 area', () => {
    const doomfist = namedPiece({
      instanceId: 'doomfist',
      templateId: 'red-doomsday-fist',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      attack: 3,
    }, '末日铁拳')
    const first = namedPiece({
      instanceId: 'first',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 2,
      currentHp: 20,
      maxHp: 20,
    }, '敌人一')
    const second = namedPiece({
      instanceId: 'second',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 4,
      y: 4,
      currentHp: 20,
      maxHp: 20,
    }, '敌人二')
    const outside = namedPiece({
      instanceId: 'outside',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 5,
      currentHp: 20,
      maxHp: 20,
    }, '范围外敌人')
    const ally = namedPiece({
      instanceId: 'ally',
      ownerPlayerId: 'player-red',
      x: 3,
      y: 2,
      currentHp: 20,
      maxHp: 20,
    }, '友军')
    const state = makeState({
      pieces: [doomfist, first, second, outside, ally],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 2
    installSkill(state, doomfist, 'earthshatter')
    const action = selectedGridAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'doomfist',
      skillId: 'earthshatter',
    }, 3, 3)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === 'doomfist')).toMatchObject({ x: 3, y: 3 })
    expect(result.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(14)
    expect(result.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(14)
    expect(result.pieces.find(piece => piece.instanceId === 'outside')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'ally')?.currentHp).toBe(20)
  })

  it('runs Chidori through every path enemy and immobilizes each survivor for one turn', () => {
    const sasuke = namedPiece({
      instanceId: 'sasuke',
      templateId: 'red-sasuke',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 1,
      attack: 3,
    }, '宇智波佐助')
    const first = namedPiece({
      instanceId: 'first',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 10,
      maxHp: 10,
    }, '敌人一')
    const second = namedPiece({
      instanceId: 'second',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 4,
      y: 1,
      currentHp: 10,
      maxHp: 10,
    }, '敌人二')
    const state = makeState({
      pieces: [sasuke, first, second],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 8,
      height: 4,
    }) as any
    state.players[0].actionPoints = 1
    installSkill(state, sasuke, 'sasuke-chidori')
    const action = selectedGridAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'sasuke',
      skillId: 'sasuke-chidori',
    }, 6, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === 'sasuke')).toMatchObject({ x: 6, y: 1 })
    for (const id of ['first', 'second']) {
      const enemy = result.pieces.find(piece => piece.instanceId === id)!
      expect(enemy.currentHp).toBe(7)
      expect(enemy.statusTags).toContainEqual(expect.objectContaining({
        type: 'chidori-immobile',
        remainingDuration: 1,
      }))
      expect(enemy.rules).toContainEqual(expect.objectContaining({ id: 'rule-chidori-immobile' }))
    }
  })

  it('adds two Kagutsuchi stacks plus at most two consumed cells and preserves distant Amaterasu', () => {
    const sasuke = namedPiece({
      instanceId: 'sasuke',
      templateId: 'red-sasuke',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
    }, '宇智波佐助')
    const target = namedPiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 3,
    }, '目标')
    const state = makeState({
      pieces: [sasuke, target],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 10,
      height: 8,
    }) as any
    state.players[0].actionPoints = 1
    state.extensions.amaterasuCells = [
      { x: 3, y: 2 },
      { x: 5, y: 3 },
      { x: 9, y: 3 },
    ]
    state.extensions.tileEffects = state.extensions.amaterasuCells.map((cell: { x: number; y: number }) => ({
      ...cell,
      sourceId: 'sasuke',
      tileType: 'amaterasu',
    })) as any
    installSkill(state, sasuke, 'sasuke-kagutsuchi')
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'sasuke',
      skillId: 'sasuke-kagutsuchi',
    }, 'target')
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const resultTarget = result.pieces.find(piece => piece.instanceId === 'target')!

    expect(resultTarget.statusTags).toContainEqual(expect.objectContaining({
      type: 'amaterasu-burn',
      stacks: 4,
    }))
    expect(result.extensions?.amaterasuCells).toEqual([{ x: 9, y: 3 }])
    expect(result.extensions?.tileEffects).toEqual([
      expect.objectContaining({ x: 9, y: 3, tileType: 'amaterasu' }),
    ])
  })

  it('caps Kagutsuchi final Amaterasu stacks at four when the target already has stacks', () => {
    const sasuke = namedPiece({ instanceId: 'sasuke', templateId: 'red-sasuke', ownerPlayerId: 'player-red', x: 0, y: 0 }, '宇智波佐助')
    const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 3 }, '目标')
    target.statusTags.push({
      id: 'existing-amaterasu',
      name: '天照灼烧',
      type: 'amaterasu-burn',
      currentDuration: -1,
      currentUses: -1,
      intensity: 2,
      stacks: 3,
    } as any)
    const state = makeState({ pieces: [sasuke, target], currentPlayerId: 'player-red', phase: 'action', width: 10, height: 8 }) as any
    state.players[0].actionPoints = 1
    state.extensions.amaterasuCells = []
    installSkill(state, sasuke, 'sasuke-kagutsuchi')
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'sasuke',
      skillId: 'sasuke-kagutsuchi',
    }, 'target')

    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const resultTarget = result.pieces.find(piece => piece.instanceId === 'target')!

    expect(resultTarget.statusTags).toContainEqual(expect.objectContaining({
      type: 'amaterasu-burn',
      stacks: 4,
    }))
  })
})
