/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills are exercised through runtime battle fixtures. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction, loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import { getPieceById } from '@/lib/game/piece-repository'
import { getSkillById } from '@/lib/game/skill-repository'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')
const ROOT_SEED = 120

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

function loadSkill(id: string): SkillDefinition {
  return loadJson<SkillDefinition>('skills', `${id}.json`)
}

function namedPiece(overrides: Parameters<typeof makePiece>[0]) {
  const piece = makePiece(overrides) as any
  piece.name = overrides?.instanceId || piece.instanceId
  return piece
}

function installSkill(state: BattleState, piece: any, skillId: string) {
  const skill = loadSkill(skillId)
  state.skillsById[skillId] = skill
  if (!piece.skills.some((entry: any) => entry.skillId === skillId)) {
    piece.skills.push({ skillId, currentCooldown: 0, usesRemaining: -1 })
  }
  return skill
}

function selectedAction(
  state: BattleState,
  base: Record<string, any>,
  target: { pieceId?: string; x?: number; y?: number },
  selectedOption?: string,
): BattleAction {
  state.skillsById ||= {}
  const prepared = prepareAction(state, base as BattleAction)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  const action = {
    ...base,
    targetPieceId: target.pieceId,
    targetX: target.x,
    targetY: target.y,
    selectedOption,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as BattleAction
  expect(prepareAction(state, action).kind).toBe('ready')
  return action
}

function executeDirect(
  skill: SkillDefinition,
  state: BattleState,
  caster: any,
  target: any = null,
  targetPosition: { x: number; y: number } | null = target ? { x: target.x, y: target.y } : null,
  selectedOption?: string,
) {
  return withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 1 }), () => executeSkillFunction(skill, {
    piece: caster,
    target,
    targetPosition,
    targets: [{ info: target, pos: targetPosition }],
    selectedOption,
    playerId: caster.ownerPlayerId,
    battle: state,
    skill,
  } as any, state))
}

beforeEach(() => {
  globalTriggerSystem.clearRules()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  globalTriggerSystem.clearRules()
  vi.restoreAllMocks()
})

describe('RED-120 character data contract', () => {
  it('registers Ichigo and Itachi with the approved stats and skill text', () => {
    const ichigo = loadJson<any>('pieces', 'blue-ichigo.json')
    const itachi = loadJson<any>('pieces', 'red-itachi.json')

    expect(ichigo).toMatchObject({
      id: 'blue-ichigo', name: '黑崎一护', faction: 'good', image: 'ichigo.jpg',
      stats: { maxHp: 12, attack: 5, defense: 0, moveRange: 4 },
      skills: [
        { skillId: 'ichigo-zangetsu', level: 1 },
        { skillId: 'ichigo-getsuga-tensho', level: 1 },
        { skillId: 'ichigo-bankai-tensa-zangetsu', level: 1 },
      ],
    })
    expect(itachi).toMatchObject({
      id: 'red-itachi', name: '宇智波鼬', faction: 'evil', image: 'itachi.jpg',
      stats: { maxHp: 10, attack: 3, defense: 0, moveRange: 4 },
      skills: [
        { skillId: 'itachi-tsukuyomi', level: 1 },
        { skillId: 'itachi-amaterasu', level: 1 },
        { skillId: 'itachi-totsuka-blade', level: 1 },
      ],
    })

    const expected = {
      'ichigo-zangetsu': ['选择相邻的一个敌人，造成100%攻击力的物理伤害。', 1, 1],
      'ichigo-getsuga-tensho': ['向同一行或同一列的一个方向发射弹射物，对路径上的第一个敌人造成150%攻击力的魔法伤害。', 2, 1],
      'ichigo-bankai-tensa-zangetsu': ['攻击力+1、移动值+2并获得1点临时行动点，失去【月牙天冲】，获得初始冷却为0的【黑色月牙天冲】。', 0, 0],
      'ichigo-black-getsuga-tensho': ['向同一行或同一列的一个方向发射弹射物，对路径上的所有敌人造成175%攻击力的魔法伤害；命中后，可以传送至第一个被命中敌人相邻的一个空格。', 2, 1],
      'itachi-tsukuyomi': ['选择4格内的一个敌人，使其下一个使用的技能额外增加1回合冷却。', 0, 1],
      'itachi-amaterasu': ['选择5格内的一个敌人，将其所在格变为天照地格，并使其获得1层天照。', 1, 2],
      'itachi-totsuka-blade': ['万花筒。选择3格内的一个敌人，造成200%攻击力的魔法伤害，并使其所有主动技能进入2回合冷却。', 2, 1],
    } as const
    for (const [id, [description, ap, cooldown]] of Object.entries(expected)) {
      const skill = loadSkill(id)
      expect(skill).toMatchObject({ id, description, actionPointCost: ap, cooldownTurns: cooldown })
      expect(skill.description).not.toMatch(/(?:AP|CD)\d|充能\d|每局限用\d次/)
    }
    expect(loadJson<{ keywords?: string[] }>('skills', 'ichigo-getsuga-tensho.json').keywords).toContain('弹射物')
    expect(loadJson<{ keywords?: string[] }>('skills', 'ichigo-black-getsuga-tensho.json').keywords).toContain('弹射物')
    expect(loadSkill('itachi-totsuka-blade')).toMatchObject({ type: 'super', chargeCost: 1 })

    expect(getPieceById('blue-ichigo')?.id).toBe('blue-ichigo')
    expect(getPieceById('red-itachi')?.id).toBe('red-itachi')
    expect(getSkillById('itachi-tsukuyomi')?.id).toBe('itachi-tsukuyomi')

    const pieceManifest = loadJson<string[]>('pieces', 'manifest.json')
    const skillManifest = loadJson<string[]>('skills', 'manifest.json')
    const ruleManifest = loadJson<string[]>('rules', 'manifest.json')
    expect(pieceManifest.filter(id => id === 'blue-ichigo')).toHaveLength(1)
    expect(pieceManifest.filter(id => id === 'red-itachi')).toHaveLength(1)
    for (const id of Object.keys(expected)) expect(skillManifest.filter(item => item === id)).toHaveLength(1)
    expect(ruleManifest.filter(id => id === 'rule-itachi-tsukuyomi')).toHaveLength(1)
  })
})

describe('RED-120 authoritative targeting', () => {
  it('limits Zangetsu to adjacent enemies and Tsukuyomi to enemies within four cells', () => {
    const ichigo = namedPiece({ instanceId: 'ichigo', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const adjacent = namedPiece({ instanceId: 'adjacent', ownerPlayerId: 'player-blue', x: 3, y: 2 })
    const diagonal = namedPiece({ instanceId: 'diagonal', ownerPlayerId: 'player-blue', x: 3, y: 3 })
    const state = makeState({ pieces: [ichigo, adjacent, diagonal], width: 9, height: 5 })
    installSkill(state, ichigo, 'ichigo-zangetsu')

    const zangetsu = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'ichigo', skillId: 'ichigo-zangetsu',
    })
    expect(zangetsu.kind).toBe('needTarget')
    expect(zangetsu.kind === 'needTarget' ? zangetsu.candidates.map(targetRefKey) : []).toEqual(['piece:adjacent'])

    const itachi = namedPiece({ instanceId: 'itachi', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const near = namedPiece({ instanceId: 'near', ownerPlayerId: 'player-blue', x: 3, y: 1 })
    const farBurning = namedPiece({ instanceId: 'far-burning', ownerPlayerId: 'player-blue', x: 8, y: 0 })
    farBurning.statusTags.push({ id: 'far-amaterasu', type: 'amaterasu-burn', stacks: 1 })
    const tsukuyomiState = makeState({ pieces: [itachi, near, farBurning], width: 9, height: 3 })
    installSkill(tsukuyomiState, itachi, 'itachi-tsukuyomi')
    const tsukuyomi = prepareAction(tsukuyomiState, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'itachi', skillId: 'itachi-tsukuyomi',
    })
    const candidates = new Set(tsukuyomi.kind === 'needTarget' ? tsukuyomi.candidates.map(targetRefKey) : [])
    expect(candidates.has('piece:near')).toBe(true)
    expect(candidates.has('piece:far-burning')).toBe(false)
  })

  it('asks only whether to teleport after an actual hit and never requests a landing cell', () => {
    const ichigo = namedPiece({ instanceId: 'ichigo', ownerPlayerId: 'player-red', x: 1, y: 1 })
    ichigo.skills = [{ skillId: 'ichigo-black-getsuga-tensho', currentCooldown: 0, usesRemaining: -1 }]
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 30, maxHp: 30 })
    const state = makeState({ pieces: [ichigo, enemy], width: 6, height: 4 })
    const base = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'ichigo', skillId: 'ichigo-black-getsuga-tensho',
    }
    const action = selectedAction(state, base, { x: 5, y: 1 })
    const actionPointsBeforePrompt = state.players[0].actionPoints
    const prompted = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    expect(prompted.pendingOptionSelection).toMatchObject({
      title: '命中后是否传送？',
      options: [
        { label: '传送', value: 'teleport' },
        { label: '不传送', value: 'stay' },
      ],
    })
    expect(prompted.pendingTargetSelection).toBeUndefined()
    expect(prompted.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(30)
    expect(prompted.players[0].actionPoints).toBe(actionPointsBeforePrompt)
    const choice = prompted.pendingOptionSelection!
    const resolved = runBattleAction(prompted, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'stay',
      selectionId: choice.selectionId,
      stateRevision: choice.stateRevision,
    } as BattleAction, { rootSeed: ROOT_SEED }).state
    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBeLessThan(30)
    expect(resolved.players[0].actionPoints).toBe(actionPointsBeforePrompt - 2)



    const missIchigo = namedPiece({ instanceId: 'miss-ichigo', ownerPlayerId: 'player-red', x: 1, y: 1 })
    missIchigo.skills = [{ skillId: 'ichigo-black-getsuga-tensho', currentCooldown: 0, usesRemaining: -1 }]
    const missState = makeState({ pieces: [missIchigo], width: 6, height: 4 })
    const missActionPoints = missState.players[0].actionPoints
    const missed = runBattleAction(missState, selectedAction(missState, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'miss-ichigo', skillId: 'ichigo-black-getsuga-tensho',
    }, { x: 5, y: 1 }), { rootSeed: ROOT_SEED }).state
    expect(missed.pendingOptionSelection).toBeUndefined()
    expect(missed.pendingTargetSelection).toBeUndefined()
    expect(missed.players[0].actionPoints).toBe(missActionPoints - 2)
  })
})

describe('RED-120 Ichigo combat behavior', () => {
  it('uses the authoritative damage pipeline for Zangetsu and the first-enemy projectile for Getsuga', () => {
    const ichigo = namedPiece({ instanceId: 'ichigo', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 5 })
    const first = namedPiece({ instanceId: 'first', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30 })
    const second = namedPiece({ instanceId: 'second', ownerPlayerId: 'player-blue', x: 3, y: 0, currentHp: 30, maxHp: 30 })
    const state = makeState({ pieces: [ichigo, first, second], width: 5, height: 2 })

    executeDirect(loadSkill('ichigo-zangetsu'), state, ichigo, first)
    expect(first.currentHp).toBe(25)

    executeDirect(loadSkill('ichigo-getsuga-tensho'), state, ichigo, null, { x: 4, y: 0 })
    expect(first.currentHp).toBe(17)
    expect(second.currentHp).toBe(30)
  })

  it('supports the same-turn Getsuga, Bankai, and initial-cooldown-zero Black Getsuga sequence', () => {
    const ichigo = namedPiece({ instanceId: 'ichigo', templateId: 'blue-ichigo', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 5, moveRange: 4 })
    ichigo.skills = [
      { skillId: 'ichigo-getsuga-tensho', currentCooldown: 0, usesRemaining: -1 },
      { skillId: 'ichigo-bankai-tensa-zangetsu', currentCooldown: 0, usesRemaining: -1 },
    ]
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 50, maxHp: 50 })
    let state = makeState({ pieces: [ichigo, enemy], width: 6, height: 3 })
    state.players[0].actionPoints = 3
    state.players[0].maxActionPoints = 3
    state.players[0].chargePoints = 1

    state = runBattleAction(state, selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'ichigo', skillId: 'ichigo-getsuga-tensho',
    }, { x: 5, y: 1 }), { rootSeed: ROOT_SEED }).state
    expect(state.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(42)

    state = runBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'ichigo', skillId: 'ichigo-bankai-tensa-zangetsu',
    }, { rootSeed: ROOT_SEED }).state
    const transformed = state.pieces.find(piece => piece.instanceId === 'ichigo')!
    expect(transformed).toMatchObject({ attack: 6, moveRange: 6 })
    expect(state.players[0]).toMatchObject({ actionPoints: 2, chargePoints: 0 })
    expect(transformed.skills.map(skill => [skill.skillId, skill.currentCooldown])).toEqual([
      ['ichigo-black-getsuga-tensho', 0],
    ])

    state = runBattleAction(state, selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'ichigo', skillId: 'ichigo-black-getsuga-tensho',
    }, { x: 5, y: 1 }, 'stay'), { rootSeed: ROOT_SEED }).state
    expect(state.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(31)
    expect(state.players[0].actionPoints).toBe(0)
    expect(state.pieces.find(piece => piece.instanceId === 'ichigo')?.skills[0]).toMatchObject({
      skillId: 'ichigo-black-getsuga-tensho', currentCooldown: 1,
    })
  })

  it('penetrates enemies up to blocking terrain and chooses a reproducible random adjacent landing', () => {
    const run = () => {
      const ichigo = namedPiece({ instanceId: 'ichigo', templateId: 'blue-ichigo', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 6 })
      ichigo.skills = [{ skillId: 'ichigo-black-getsuga-tensho', currentCooldown: 0, usesRemaining: -1 }]
      const first = namedPiece({ instanceId: 'first', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 40, maxHp: 40 })
      const second = namedPiece({ instanceId: 'second', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 40, maxHp: 40 })
      const blocked = namedPiece({ instanceId: 'blocked', ownerPlayerId: 'player-blue', x: 6, y: 1, currentHp: 40, maxHp: 40 })
      const state = makeState({ pieces: [ichigo, first, second, blocked], width: 8, height: 3 })
      const wall = state.map.tiles.find(tile => tile.x === 5 && tile.y === 1)!
      wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false } as any
      const action = selectedAction(state, {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'ichigo', skillId: 'ichigo-black-getsuga-tensho',
      }, { x: 7, y: 1 }, 'teleport')
      return runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    }

    const firstRun = run()
    const secondRun = run()
    expect(firstRun.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(29)
    expect(firstRun.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(29)
    expect(firstRun.pieces.find(piece => piece.instanceId === 'blocked')?.currentHp).toBe(40)
    const landing = firstRun.pieces.find(piece => piece.instanceId === 'ichigo')!
    expect(Math.abs(landing.x! - 2) + Math.abs(landing.y! - 1)).toBe(1)
    expect(secondRun.pieces.find(piece => piece.instanceId === 'ichigo')).toMatchObject({ x: landing.x, y: landing.y })
  })

  it('applies landing tile effects without applying effects from cells crossed by the teleport', () => {
    const run = (amaterasuCells: Array<{ x: number; y: number }>) => {
      const ichigo = namedPiece({ instanceId: 'ichigo', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 6 })
      const first = namedPiece({ instanceId: 'first', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 40, maxHp: 40 })
      const pathBlocker = namedPiece({ instanceId: 'path-ally', ownerPlayerId: 'player-red', x: 1, y: 1 })
      const rightBlocker = namedPiece({ instanceId: 'right-ally', ownerPlayerId: 'player-red', x: 3, y: 1 })
      const downBlocker = namedPiece({ instanceId: 'down-ally', ownerPlayerId: 'player-red', x: 2, y: 2 })
      const state = makeState({
        pieces: [ichigo, first, pathBlocker, rightBlocker, downBlocker],
        width: 5,
        height: 3,
      })
      state.extensions = state.extensions || {}
      state.extensions.amaterasuCells = amaterasuCells
      executeDirect(loadSkill('ichigo-black-getsuga-tensho'), state, ichigo, null, { x: 4, y: 1 }, 'teleport')
      return { state, ichigo }
    }

    const crossedOnly = run([{ x: 1, y: 1 }])
    expect(crossedOnly.ichigo).toMatchObject({ x: 2, y: 0 })
    expect(crossedOnly.ichigo.statusTags.some((tag: any) => tag.type === 'amaterasu-burn')).toBe(false)

    const landing = run([{ x: 2, y: 0 }])
    expect(landing.ichigo).toMatchObject({ x: 2, y: 0 })
    expect(landing.ichigo.statusTags).toContainEqual(expect.objectContaining({
      type: 'amaterasu-burn',
      stacks: 1,
    }))
  })


  it('keeps the caster in place when the first target has no legal adjacent landing', () => {
    const ichigo = namedPiece({ instanceId: 'ichigo', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 6 })
    const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 40, maxHp: 40 })
    const blockers = [
      namedPiece({ instanceId: 'right', ownerPlayerId: 'player-blue', x: 3, y: 1 }),
      namedPiece({ instanceId: 'up', ownerPlayerId: 'player-blue', x: 2, y: 0 }),
      namedPiece({ instanceId: 'down', ownerPlayerId: 'player-blue', x: 2, y: 2 }),
    ]
    const state = makeState({ pieces: [ichigo, target, ...blockers], width: 5, height: 3 })
    const result = executeDirect(loadSkill('ichigo-black-getsuga-tensho'), state, ichigo, null, { x: 4, y: 1 }, 'teleport')
    expect(result.success).toBe(true)
    expect(ichigo).toMatchObject({ x: 1, y: 1 })
    expect(target.currentHp).toBe(29)
  })
})

describe('RED-120 Itachi combat behavior', () => {
  it('applies one non-expiring Tsukuyomi marker and adds one cooldown to the next used skill', () => {
    const itachi = namedPiece({ instanceId: 'itachi', templateId: 'red-itachi', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 3 })
    itachi.skills = [{ skillId: 'itachi-tsukuyomi', currentCooldown: 0, usesRemaining: -1 }]
    const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 1, attack: 2 })
    target.skills = [{ skillId: 'basic-attack', currentCooldown: 0, usesRemaining: -1 }]
    let state = makeState({ pieces: [itachi, target], width: 5, height: 3 })

    state = runBattleAction(state, selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'itachi', skillId: 'itachi-tsukuyomi',
    }, { pieceId: 'target' }), { rootSeed: ROOT_SEED }).state
    const marked = state.pieces.find(piece => piece.instanceId === 'target')!
    expect(marked.statusTags).toEqual([expect.objectContaining({
      type: 'itachi-tsukuyomi', remainingDuration: -1,
    })])
    expect(marked.rules?.filter(rule => rule.id === 'rule-itachi-tsukuyomi')).toHaveLength(1)

    state.turn.currentPlayerId = 'player-blue'
    state.players[1].actionPoints = 2
    state = runBattleAction(state, selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: 'target', skillId: 'basic-attack',
    }, { pieceId: 'itachi' }), { rootSeed: ROOT_SEED }).state
    const consumed = state.pieces.find(piece => piece.instanceId === 'target')!
    expect(consumed.skills.find(skill => skill.skillId === 'basic-attack')?.currentCooldown).toBe(1)
    expect(consumed.statusTags.some(tag => tag.type === 'itachi-tsukuyomi')).toBe(false)
  })

  it('does not stack repeated Tsukuyomi applications into multiple triggers', () => {
    const itachi = namedPiece({ instanceId: 'itachi', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 0 })
    const state = makeState({ pieces: [itachi, target], width: 5, height: 2 })
    const skill = loadSkill('itachi-tsukuyomi')
    executeDirect(skill, state, itachi, target)
    executeDirect(skill, state, itachi, target)
    expect(target.statusTags.filter((tag: any) => tag.type === 'itachi-tsukuyomi')).toHaveLength(1)
    expect(target.rules.filter((rule: any) => rule.id === 'rule-itachi-tsukuyomi')).toHaveLength(1)
  })

  it('creates the shared Amaterasu cell and stack that Sasuke Kagutsuchi can consume', () => {
    const itachi = namedPiece({ instanceId: 'itachi', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 3, y: 0 })
    const state = makeState({ pieces: [itachi, target], width: 6, height: 2 })
    executeDirect(loadSkill('itachi-amaterasu'), state, itachi, target)

    expect(state.extensions?.amaterasuCells).toEqual([{ x: 3, y: 0 }])
    expect(state.extensions?.tileEffects).toContainEqual(expect.objectContaining({ x: 3, y: 0, tileType: 'amaterasu' }))
    expect(target.statusTags).toContainEqual(expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 }))
    expect(state.players[0].rules?.map(rule => rule.id)).toEqual(expect.arrayContaining([
      'rule-sasuke-amaterasu-move', 'rule-sasuke-amaterasu-stack', 'rule-sasuke-amaterasu-damage',
    ]))

    executeDirect(loadSkill('sasuke-kagutsuchi'), state, itachi, target)
    expect(state.extensions?.amaterasuCells).toEqual([])
    expect(target.statusTags.find((tag: any) => tag.type === 'amaterasu-burn')?.stacks).toBe(3)
  })

  it('pays for Totsuka Blade, deals 200% magical damage, and floors all active cooldowns at two', () => {
    const itachi = namedPiece({ instanceId: 'itachi', templateId: 'red-itachi', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 3 })
    itachi.skills = [{ skillId: 'itachi-totsuka-blade', currentCooldown: 0, usesRemaining: -1 }]
    const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 30, maxHp: 30 })
    target.skills = [
      { skillId: 'basic-attack', currentCooldown: 0, usesRemaining: -1 },
      { skillId: 'sleep-dart', currentCooldown: 3, usesRemaining: -1 },
    ]
    let state = makeState({ pieces: [itachi, target], width: 5, height: 2 })
    state.players[0].chargePoints = 1
    state = runBattleAction(state, selectedAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'itachi', skillId: 'itachi-totsuka-blade',
    }, { pieceId: 'target' }), { rootSeed: ROOT_SEED }).state

    const sealed = state.pieces.find(piece => piece.instanceId === 'target')!
    expect(sealed.currentHp).toBe(24)
    expect(sealed.skills.map(skill => skill.currentCooldown)).toEqual([2, 3])
    expect(state.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(state.pieces.find(piece => piece.instanceId === 'itachi')?.skills[0]).toMatchObject({
      currentCooldown: 1,
      usesRemaining: -1,
    })
  })

  it('loads the Tsukuyomi rule referenced by the status tag', () => {
    expect(loadRuleById('rule-itachi-tsukuyomi', true)?.id).toBe('rule-itachi-tsukuyomi')
  })
})
