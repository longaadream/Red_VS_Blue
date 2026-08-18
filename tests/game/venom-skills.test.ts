/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skill scripts and legacy battle fixtures are validated at runtime in this test. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const TRIGGER_OK = { success: true, messages: [], blocked: false }
vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    checkTriggers: vi.fn(() => TRIGGER_OK),
    updateCooldowns: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    clearRules: vi.fn(),
    getRules: vi.fn(() => []),
  },
  TriggerType: {},
}))

import { executeSkillFunction } from '@/lib/game/skills'
import { applyBattleAction } from '@/lib/game/turn'
import { getPieceById } from '@/lib/game/piece-repository'
import { getSkillById } from '@/lib/game/skill-repository'
import type { BattleState } from '@/lib/game/turn'
import type { SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState, makeTile } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')

type SkillData = SkillDefinition & { keywords: string[] }

type DragFailureSetup = {
  enemyX: number
  enemyY: number
  targetX: number
  targetY: number
  blockLanding?: boolean
}

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

const hostTransfer = () => loadJson<SkillDefinition>('skills', 'venom-host-transfer.json')
const symbioteDrag = () => loadJson<SkillDefinition>('skills', 'venom-symbiote-drag.json')
const clawRend = () => loadJson<SkillDefinition>('skills', 'venom-claw-rend.json')

function executeSkill(
  skill: SkillDefinition,
  state: BattleState,
  casterId: string,
  target: { pieceId?: string; x?: number; y?: number },
) {
  const caster = state.pieces.find(piece => piece.instanceId === casterId)!
  const targetPiece = target.pieceId
    ? state.pieces.find(piece => piece.instanceId === target.pieceId) ?? null
    : null
  const targetPosition = targetPiece
    ? { x: targetPiece.x!, y: targetPiece.y! }
    : target.x !== undefined && target.y !== undefined
      ? { x: target.x, y: target.y }
      : null

  return executeSkillFunction(skill, {
    piece: caster,
    target: targetPiece,
    targetPosition,
    targets: [{ info: targetPiece, pos: targetPosition }],
    battle: state,
    playerId: caster.ownerPlayerId,
    skill: {
      id: skill.id,
      name: skill.name,
      type: skill.type,
      powerMultiplier: skill.powerMultiplier,
    },
  } as any, state)
}

function setTile(
  state: BattleState,
  x: number,
  y: number,
  props: { type: string; walkable: boolean; bulletPassable: boolean },
) {
  state.map.tiles = state.map.tiles.map(tile => tile.x === x && tile.y === y
    ? { ...makeTile(x, y, props.walkable), props: { ...tile.props, ...props } } as any
    : tile)
}

function withTargetCredentials(state: BattleState, action: Record<string, any>) {
  const draft = { ...action }
  delete draft.targetPieceId
  delete draft.targetX
  delete draft.targetY
  const prepared = prepareAction(state, draft as any)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target preparation, received ${prepared.kind}`)
  return { ...action, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

describe('Venom data contract', () => {
  it('loads the approved dark-faction piece stats and skill list', () => {
    const piece = loadJson<any>('pieces', 'red-venom.json')

    expect(piece).toMatchObject({
      id: 'red-venom',
      name: '毒液',
      faction: 'evil',
      stats: { maxHp: 14, attack: 3, defense: 1, moveRange: 4 },
      skills: [
        { skillId: 'venom-host-transfer', level: 1 },
        { skillId: 'venom-symbiote-drag', level: 1 },
        { skillId: 'venom-claw-rend', level: 1 },
      ],
    })

    expect(getPieceById('red-venom')).toMatchObject({ id: 'red-venom', faction: 'evil' })
    expect([
      getSkillById('venom-host-transfer')?.id,
      getSkillById('venom-symbiote-drag')?.id,
      getSkillById('venom-claw-rend')?.id,
    ]).toEqual(['venom-host-transfer', 'venom-symbiote-drag', 'venom-claw-rend'])

  })
  it('registers the piece and all three skills exactly once', () => {
    const pieceManifest = loadJson<string[]>('pieces', 'manifest.json')
    const skillManifest = loadJson<string[]>('skills', 'manifest.json')
    const ids = ['venom-host-transfer', 'venom-symbiote-drag', 'venom-claw-rend']

    expect(pieceManifest.filter(id => id === 'red-venom')).toHaveLength(1)
    for (const id of ids) expect(skillManifest.filter(candidate => candidate === id)).toHaveLength(1)
    expect(new Set(pieceManifest).size).toBe(pieceManifest.length)
    expect(new Set(skillManifest).size).toBe(skillManifest.length)
  })

  it('exposes the approved costs, cooldowns, ranges and descriptions', () => {
    expect(hostTransfer()).toMatchObject({ actionPointCost: 1, cooldownTurns: 1, targetText: '7格内任意另一名存活角色', keywords: [], effectTags: [] })
    expect(symbioteDrag()).toMatchObject({ actionPointCost: 0, cooldownTurns: 1, form: 'projectile', keywords: ['弹射物'], effectTags: ['弹射物'] })
    expect(clawRend()).toMatchObject({ actionPointCost: 1, cooldownTurns: 1, powerMultiplier: 1, keywords: [], effectTags: [] })
  })

  it('uses the full Minato display name and exposes no Minato skill keywords', () => {
    const minato = loadJson<any>('pieces', 'blue-minato.json')
    const minatoSkillFiles = [
      'minato-flying-raijin-passive.json',
      'minato-kunai-formula.json',
      'minato-rasengan.json',
      'minato-spiral-barrage.json',
    ]

    expect(minato.name).toBe('波风水门')
    for (const file of minatoSkillFiles) expect(loadJson<SkillData>('skills', file).keywords).toEqual([])
  })
})

describe('宿主转移', () => {
  it.each([
    ['友军', 'player-red', 'ally'],
    ['敌军', 'player-blue', 'enemy'],
    ['召唤物', 'player-red', 'summoned-unit'],
  ])('与7格内的%s交换位置', (_label, ownerPlayerId, templateId) => {
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const target = makePiece({ instanceId: 'target', templateId, ownerPlayerId, x: 4, y: 3 })
    const state = makeState({ pieces: [venom, target], width: 10, height: 10 })

    const result = executeSkill(hostTransfer(), state, 'venom', { pieceId: 'target' })

    expect(result.success).toBe(true)
    expect(state.pieces.find(piece => piece.instanceId === 'venom')).toMatchObject({ x: 4, y: 3 })
    expect(state.pieces.find(piece => piece.instanceId === 'target')).toMatchObject({ x: 0, y: 0 })
  })

  it.each([
    ['自身', makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 0 }), 'venom'],
    ['死亡角色', makePiece({ instanceId: 'dead', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 0 }), 'dead'],
    ['8格外角色', makePiece({ instanceId: 'far', ownerPlayerId: 'player-blue', x: 8, y: 0 }), 'far'],
  ])('拒绝%s且不改变位置', (_label, target, targetId) => {
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const pieces = targetId === 'venom' ? [venom] : [venom, target]
    const state = makeState({ pieces, width: 10, height: 10 })
    const before = JSON.stringify(state.pieces)

    const result = executeSkill(hostTransfer(), state, 'venom', { pieceId: targetId })

    expect(result.success).toBe(false)
    expect(JSON.stringify(state.pieces)).toBe(before)
  })

  it('成功时消耗1 AP并进入1回合冷却，选择自身不结算资源', () => {
    const skill = hostTransfer()
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    venom.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 4, y: 3 })
    const state = makeState({ pieces: [venom, target], width: 10, height: 10 }) as any
    state.skillsById[skill.id] = skill
    state.players[0].actionPoints = 2

    const next = applyBattleAction(state, withTargetCredentials(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'venom', skillId: skill.id, targetPieceId: 'target',
    }) as any) as any
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find((piece: any) => piece.instanceId === 'venom').skills[0].currentCooldown).toBe(1)

    const invalid = makeState({ pieces: [venom], width: 10, height: 10 }) as any
    invalid.skillsById[skill.id] = skill
    invalid.players[0].actionPoints = 2
    const before = JSON.stringify(invalid)
    expect(() => applyBattleAction(invalid, withTargetCredentials(invalid, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'venom', skillId: skill.id, targetPieceId: 'venom',
    }) as any)).toThrow()
    expect(JSON.stringify(invalid)).toBe(before)
  })
})

describe('共生拖行', () => {
  it.each([
    ['右', 5, 2, 1, 0],
    ['左', 0, 2, -1, 0],
    ['下', 2, 4, 0, 1],
    ['上', 2, 0, 0, -1],
  ])('沿%s侧无限直线把首个敌人拉到身前', (_label, targetX, targetY, dx, dy) => {
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: targetX, y: targetY })
    const state = makeState({ pieces: [venom, enemy], width: 8, height: 8 })

    const result = executeSkill(symbioteDrag(), state, 'venom', { x: targetX, y: targetY })

    expect(result.success).toBe(true)
    expect(enemy).toMatchObject({ x: 2 + dx, y: 2 + dy })
  })

  it('穿过深坑，但被墙壁和空掩体阻挡', () => {
    const makeLineState = () => {
      const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 1 })
      const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 1 })
      return { state: makeState({ pieces: [venom, enemy], width: 6, height: 3 }), enemy }
    }

    const holeCase = makeLineState()
    setTile(holeCase.state, 2, 1, { type: 'hole', walkable: false, bulletPassable: true })
    expect(executeSkill(symbioteDrag(), holeCase.state, 'venom', { x: 5, y: 1 }).success).toBe(true)
    expect(holeCase.enemy.x).toBe(1)

    for (const terrain of [
      { type: 'wall', walkable: false, bulletPassable: false },
      { type: 'cover', walkable: true, bulletPassable: false },
    ]) {
      const blocked = makeLineState()
      setTile(blocked.state, 2, 1, terrain)
      const before = JSON.stringify(blocked.state.pieces)
      expect(executeSkill(symbioteDrag(), blocked.state, 'venom', { x: 5, y: 1 }).success).toBe(false)
      expect(JSON.stringify(blocked.state.pieces)).toBe(before)
    }
  })

  it('可命中掩体上的敌人，但被路径上的友军阻挡', () => {
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 1 })
    const state = makeState({ pieces: [venom, enemy], width: 6, height: 3 })
    setTile(state, 4, 1, { type: 'cover', walkable: true, bulletPassable: false })

    expect(executeSkill(symbioteDrag(), state, 'venom', { x: 5, y: 1 }).success).toBe(true)
    expect(enemy.x).toBe(1)

    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    enemy.x = 4
    state.pieces.splice(1, 0, ally as any)
    const before = JSON.stringify(state.pieces)
    expect(executeSkill(symbioteDrag(), state, 'venom', { x: 5, y: 1 }).success).toBe(false)
    expect(JSON.stringify(state.pieces)).toBe(before)
  })

  it.each<[string, DragFailureSetup]>([
    ['相邻敌人', { enemyX: 1, enemyY: 1, targetX: 5, targetY: 1 }],
    ['斜线方向', { enemyX: 4, enemyY: 1, targetX: 4, targetY: 2 }],
    ['非法落点', { enemyX: 4, enemyY: 1, targetX: 5, targetY: 1, blockLanding: true }],
  ])('拒绝%s且不改变状态', (_label, setup) => {
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: setup.enemyX, y: setup.enemyY })
    const state = makeState({ pieces: [venom, enemy], width: 6, height: 4 })
    if (setup.blockLanding) setTile(state, 1, 1, { type: 'hole', walkable: false, bulletPassable: true })
    const before = JSON.stringify(state)

    const result = executeSkill(symbioteDrag(), state, 'venom', { x: setup.targetX, y: setup.targetY })

    expect(result.success).toBe(false)
    expect(JSON.stringify(state)).toBe(before)
  })

  it('成功时消耗0 AP并进入1回合冷却，非法目标不结算资源', () => {
    const skill = symbioteDrag()
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 0, y: 1 }) as any
    venom.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 1 })
    const state = makeState({ pieces: [venom, enemy], width: 6, height: 3 }) as any
    state.skillsById[skill.id] = skill
    state.players[0].actionPoints = 2

    const next = applyBattleAction(state, withTargetCredentials(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'venom', skillId: skill.id, targetX: 5, targetY: 1,
    }) as any) as any
    expect(next.players[0].actionPoints).toBe(2)
    expect(next.pieces.find((piece: any) => piece.instanceId === 'venom').skills[0].currentCooldown).toBe(1)

    const adjacent = makeState({ pieces: [venom, makePiece({ instanceId: 'adjacent', ownerPlayerId: 'player-blue', x: 1, y: 1 })], width: 6, height: 3 }) as any
    adjacent.skillsById[skill.id] = skill
    adjacent.players[0].actionPoints = 2
    const before = JSON.stringify(adjacent)
    expect(() => applyBattleAction(adjacent, withTargetCredentials(adjacent, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'venom', skillId: skill.id, targetX: 5, targetY: 1,
    }) as any)).toThrow()
    expect(JSON.stringify(adjacent)).toBe(before)
  })
})

describe('利爪撕裂', () => {
  it('对1格内敌人造成100%攻击力的物理伤害', () => {
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 3 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 10, maxHp: 10 })
    const state = makeState({ pieces: [venom, enemy] })

    const result = executeSkill(clawRend(), state, 'venom', { pieceId: 'enemy' })

    expect(result.success).toBe(true)
    expect(enemy.currentHp).toBe(7)
  })

  it('成功时消耗1 AP并进入1回合冷却，超出1格不结算资源', () => {
    const skill = clawRend()
    const venom = makePiece({ instanceId: 'venom', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 3 }) as any
    venom.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 10, maxHp: 10 })
    const state = makeState({ pieces: [venom, enemy] }) as any
    state.skillsById[skill.id] = skill
    state.players[0].actionPoints = 2

    const next = applyBattleAction(state, withTargetCredentials(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'venom', skillId: skill.id, targetPieceId: 'enemy',
    }) as any) as any
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find((piece: any) => piece.instanceId === 'venom').skills[0].currentCooldown).toBe(1)

    const farEnemy = makePiece({ instanceId: 'far-enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
    const invalid = makeState({ pieces: [venom, farEnemy] }) as any
    invalid.skillsById[skill.id] = skill
    invalid.players[0].actionPoints = 2
    const before = JSON.stringify(invalid)
    expect(() => applyBattleAction(invalid, withTargetCredentials(invalid, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'venom', skillId: skill.id, targetPieceId: 'far-enemy',
    }) as any)).toThrow()
    expect(JSON.stringify(invalid)).toBe(before)
  })
})
