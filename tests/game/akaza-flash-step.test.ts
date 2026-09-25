/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills use dynamic selection and flow fields. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { dealDamage, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { finalizePendingTargetSession, prepareAction } from '@/lib/game/targeting'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 217
const DATA_ROOT = join(process.cwd(), 'data')

function loadSkill(id: string) {
  return JSON.parse(readFileSync(join(DATA_ROOT, 'skills', `${id}.json`), 'utf8')) as any
}

function loadDamageMarkRule() {
  const rule = loadRuleById('rule-akaza-damage-mark', true)
  if (!rule) throw new Error('Missing fixture rule: rule-akaza-damage-mark')
  return rule
}

function flashStepFixture(options: {
  akaza?: Partial<any>
  enemies?: Array<Partial<any> & { instanceId: string; x: number; y: number }>
  width?: number
  height?: number
} = {}) {
  const akaza = makePiece({
    instanceId: 'akaza', templateId: 'dark-akaza', ownerPlayerId: 'player-red', faction: 'red',
    x: 3, y: 3, currentHp: 16, maxHp: 16, attack: 4, moveRange: 5,
    skills: [{ skillId: 'akaza-flash-step', currentCooldown: 0, usesRemaining: -1 }],
    rules: [loadDamageMarkRule()],
    ...options.akaza,
  }) as any
  akaza.name = '猗窝座'
  const enemies = (options.enemies ?? [{ instanceId: 'enemy', x: 5, y: 3 }]).map(enemy => makePiece({
    ...enemy,
    ownerPlayerId: 'player-blue', faction: 'blue',
    currentHp: enemy.currentHp ?? 20, maxHp: enemy.maxHp ?? 20,
  }) as any)
  const state = makeState({
    pieces: [akaza, ...enemies],
    currentPlayerId: 'player-red',
    width: options.width ?? 8,
    height: options.height ?? 8,
  }) as any
  state.players[0].actionPoints = 0
  state.players[0].maxActionPoints = 0
  state.skillsById['akaza-flash-step'] = loadAllSkillsById()['akaza-flash-step'] ?? loadSkill('akaza-flash-step')
  return { state: state as BattleState, akaza, enemies }
}

function prepareFirstSelection(state: BattleState, pieceId = 'akaza') {
  const action = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId,
    skillId: 'akaza-flash-step',
  }
  const prepared = prepareAction(state, action)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected first target selection, got ${prepared.kind}`)
  return { action, prepared }
}

function selectedAction(state: BattleState, targetPieceId: string, x: number, y: number, pieceId = 'akaza'): BattleAction {
  const { action, prepared } = prepareFirstSelection(state, pieceId)
  return {
    ...action,
    targetPieceId,
    extraTargets: [{ x, y }],
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as any
}

function recordActualDamage(state: BattleState, akaza: any, target: any, amount = 1) {
  return dealDamage(akaza, target, amount, 'physical', state, 'akaza-history-test')
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('Akaza Flash Step data and targeting', () => {
  it('declares the approved zero-cost cooldown and two-step 7x7 targeting contract', () => {
    const skill = loadSkill('akaza-flash-step')
    expect(skill).toMatchObject({
      name: '瞬步', keywords: [], actionPointCost: 0, cooldownTurns: 3,
    })
    expect(skill.statusTag).toBeUndefined()
    expect(skill.description).toContain('自身为中心7x7范围内，本局内曾被自身造成过伤害的敌军')
    expect(skill.description).toContain('攻击力永久+1，可叠加')
    expect(skill.targeting.steps[0]).toMatchObject({
      type: 'piece', filter: 'enemy', range: 3, distanceMetric: 'chebyshev',
      requireOpenCardinalLanding: true,
      excludeSourceLanding: true,
      requiredTargetStatuses: ['akaza-damaged'],
      requiredTargetStatusFromSource: 'akaza-damaged',
    })
    expect(skill.targeting.steps[1]).toMatchObject({
      type: 'grid', filter: 'all', range: 99, requireWalkable: true, requireUnoccupied: true,
      distanceFromSelectedTarget: { index: 0, range: 1, minRange: 1 },
    })
  })

  it('selects only living enemies inside the 7x7 area with a per-source damage marker', () => {
    const { state, akaza, enemies } = flashStepFixture({
      enemies: [
        { instanceId: 'inside', x: 6, y: 6 },
        { instanceId: 'outside', x: 7, y: 7 },
        { instanceId: 'unhurt', x: 5, y: 2 },
        { instanceId: 'dead', x: 5, y: 4, currentHp: 0 },
      ],
    })
    recordActualDamage(state, akaza, enemies[0])
    recordActualDamage(state, akaza, enemies[1])
    enemies[3].statusTags = [{
      id: 'akaza-damaged-by:akaza', type: 'akaza-damaged', sourceId: akaza.instanceId,
      visible: false, remainingDuration: -1, currentDuration: -1,
    }]

    const { prepared } = prepareFirstSelection(state)
    expect(prepared.candidates).toEqual([{ type: 'piece', pieceId: 'inside' }])
  })

  it('uses a real positive damage marker across turns and keeps it permanently hidden', () => {
    const { state, akaza, enemies } = flashStepFixture()
    recordActualDamage(state, akaza, enemies[0])
    expect(enemies[0].statusTags).toContainEqual(expect.objectContaining({
      id: 'akaza-damaged-by:akaza', type: 'akaza-damaged', sourceId: 'akaza',
      visible: false, currentDuration: -1, remainingDuration: -1, lastDamageTurn: 1,
    }))
    state.turn.turnNumber = 2
    recordActualDamage(state, akaza, enemies[0])
    expect(enemies[0].statusTags).toContainEqual(expect.objectContaining({ lastDamageTurn: 2 }))

    const { prepared } = prepareFirstSelection(state)
    expect(prepared.candidates).toContainEqual({ type: 'piece', pieceId: 'enemy' })

    const marker = enemies[0].statusTags.find((tag: any) => tag.type === 'akaza-damaged')!
    expect(marker.remainingDuration).toBe(-1)
    expect(marker.currentDuration).toBe(-1)
  })

  it('does not treat zero final damage as history', () => {
    const { state, akaza, enemies } = flashStepFixture()
    enemies[0].shield = 4
    expect(recordActualDamage(state, akaza, enemies[0], 4).damage).toBe(0)
    state.actions!.push({
      type: 'damage', playerId: 'player-red', turn: state.turn.turnNumber,
      payload: { sourceId: akaza.instanceId, targetId: enemies[0].instanceId, finalDamage: 99 },
    } as any)

    const { prepared } = prepareFirstSelection(state)
    expect(prepared.candidates).not.toContainEqual({ type: 'piece', pieceId: 'enemy' })
    expect(() => runBattleAction(
      state,
      selectedAction(state, 'enemy', 5, 4),
      { rootSeed: ROOT_SEED },
    )).toThrow()
  })

  it('does not expose a target whose only open cardinal landing is Akaza origin', () => {
    const { state, akaza, enemies } = flashStepFixture({
      enemies: [{ instanceId: 'adjacent', x: 4, y: 3 }],
    })
    recordActualDamage(state, akaza, enemies[0])
    for (const [x, y] of [[5, 3], [4, 2], [4, 4]]) {
      state.map.tiles.find(tile => tile.x === x && tile.y === y)!.props.walkable = false
    }

    const { prepared } = prepareFirstSelection(state)
    expect(prepared.candidates).not.toContainEqual({ type: 'piece', pieceId: 'adjacent' })
  })

  it('isolates damage markers by Akaza source', () => {
    const { state, akaza, enemies } = flashStepFixture()
    const secondAkaza = makePiece({
      instanceId: 'akaza-2', templateId: 'dark-akaza', ownerPlayerId: 'player-red', faction: 'red',
      x: 2, y: 3, currentHp: 16, maxHp: 16, attack: 4, moveRange: 5,
      skills: [{ skillId: 'akaza-flash-step', currentCooldown: 0, usesRemaining: -1 }],
      rules: [loadDamageMarkRule()],
    }) as any
    secondAkaza.name = '猗窝座二号'
    state.pieces.push(secondAkaza)

    recordActualDamage(state, secondAkaza, enemies[0])
    expect(enemies[0].statusTags).toContainEqual(expect.objectContaining({
      id: 'akaza-damaged-by:akaza-2', sourceId: 'akaza-2', visible: false,
    }))
    expect(enemies[0].statusTags).not.toContainEqual(expect.objectContaining({ sourceId: akaza.instanceId }))
    expect(prepareFirstSelection(state).prepared.candidates).not.toContainEqual({ type: 'piece', pieceId: 'enemy' })
    expect(prepareFirstSelection(state, 'akaza-2').prepared.candidates).toContainEqual({ type: 'piece', pieceId: 'enemy' })

    const result = runBattleAction(
      state,
      selectedAction(state, 'enemy', 5, 4, 'akaza-2'),
      { rootSeed: ROOT_SEED },
    ).state as any
    expect(result.pieces.find((piece: any) => piece.instanceId === 'akaza-2')).toMatchObject({ x: 5, y: 4, attack: 5 })
  })
})

describe('瞬步', () => {
  it('teleports through the real action runner and adds one permanent attack', () => {
    const { state, akaza, enemies } = flashStepFixture()
    recordActualDamage(state, akaza, enemies[0])

    const result = runBattleAction(
      state,
      selectedAction(state, 'enemy', 5, 4),
      { rootSeed: ROOT_SEED },
    ).state as any
    const moved = result.pieces.find((piece: any) => piece.instanceId === 'akaza')

    expect(moved).toMatchObject({ x: 5, y: 4, attack: 5 })
    expect(result.players[0].actionPoints).toBe(0)
    expect(moved.skills.find((skill: any) => skill.skillId === 'akaza-flash-step')).toMatchObject({ currentCooldown: 3 })
  })

  it('permanently stacks attack for each later successful teleport', () => {
    const { state, akaza, enemies } = flashStepFixture({
      enemies: [
        { instanceId: 'first', x: 5, y: 3 },
        { instanceId: 'second', x: 6, y: 4 },
      ],
    })
    recordActualDamage(state, akaza, enemies[0])
    recordActualDamage(state, akaza, enemies[1])

    let next = runBattleAction(
      state,
      selectedAction(state, 'first', 5, 4),
      { rootSeed: ROOT_SEED },
    ).state as any
    next.skillsById = { 'akaza-flash-step': loadSkill('akaza-flash-step') }
    const nextAkaza = next.pieces.find((piece: any) => piece.instanceId === 'akaza')
    nextAkaza.skills.find((skill: any) => skill.skillId === 'akaza-flash-step').currentCooldown = 0

    next = runBattleAction(
      next,
      selectedAction(next, 'second', 6, 5),
      { rootSeed: ROOT_SEED },
    ).state as any
    expect(next.pieces.find((piece: any) => piece.instanceId === 'akaza')).toMatchObject({ x: 6, y: 5, attack: 6 })
  })

  it('rejects non-adjacent, occupied, and blocked destinations without changing attack', () => {
    const { state, akaza, enemies } = flashStepFixture()
    recordActualDamage(state, akaza, enemies[0])
    const before = JSON.stringify(state)

    expect(() => runBattleAction(
      state,
      selectedAction(state, 'enemy', 4, 4),
      { rootSeed: ROOT_SEED },
    )).toThrow()
    expect(JSON.stringify(state)).toBe(before)

    const occupied = flashStepFixture()
    recordActualDamage(occupied.state, occupied.akaza, occupied.enemies[0])
    occupied.state.pieces.push(makePiece({
      instanceId: 'blocker', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 4,
    }) as any)
    expect(() => runBattleAction(
      occupied.state,
      selectedAction(occupied.state, 'enemy', 5, 4),
      { rootSeed: ROOT_SEED },
    )).toThrow()
    expect(occupied.akaza).toMatchObject({ attack: 4, x: 3, y: 3 })

    const wall = flashStepFixture()
    recordActualDamage(wall.state, wall.akaza, wall.enemies[0])
    const wallTile = wall.state.map.tiles.find(tile => tile.x === 5 && tile.y === 4)!
    wallTile.props.walkable = false
    expect(() => runBattleAction(
      wall.state,
      selectedAction(wall.state, 'enemy', 5, 4),
      { rootSeed: ROOT_SEED },
    )).toThrow()
    expect(wall.akaza).toMatchObject({ attack: 4, x: 3, y: 3 })
  })

  it('cancels without changing position, attack, or cooldown', () => {
    const { state, akaza, enemies } = flashStepFixture()
    recordActualDamage(state, akaza, enemies[0])
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      source: { type: 'skill', id: 'akaza-flash-step', pieceId: 'akaza' },
      targetType: 'cell',
      filter: 'all',
      steps: [{ type: 'cell', filter: 'all', range: 99 }],
      selectedTargets: [{ type: 'piece', pieceId: 'enemy' }],
    }, 0)
    const pendingSelection = state.pendingTargetSelection!
    const cancelled = runBattleAction(state, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: pendingSelection.selectionId,
      stateRevision: pendingSelection.stateRevision,
    } as any, { rootSeed: ROOT_SEED }).state as any

    expect(cancelled.pieces.find((piece: any) => piece.instanceId === 'akaza')).toMatchObject({ x: 3, y: 3, attack: 4 })
    expect(cancelled.pieces.find((piece: any) => piece.instanceId === 'akaza').skills[0].currentCooldown).toBe(0)
  })

  it('keeps the hidden damage marker after the target owner ends a turn', () => {
    const { state, akaza, enemies } = flashStepFixture()
    recordActualDamage(state, akaza, enemies[0])
    state.turn.currentPlayerId = 'player-blue'

    const next = runBattleAction(
      state,
      { type: 'endTurn', playerId: 'player-blue' },
      { rootSeed: ROOT_SEED },
    ).state as any
    expect(next.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toContainEqual(expect.objectContaining({
      id: 'akaza-damaged-by:akaza', type: 'akaza-damaged', visible: false,
      remainingDuration: -1, currentDuration: -1,
    }))
  })

  it('does not add attack when movement contacts kill Akaza before the effect completes', () => {
    const { state, akaza, enemies } = flashStepFixture()
    recordActualDamage(state, akaza, enemies[0])
    akaza.currentHp = 1
    globalTriggerSystem.addRule({
      id: 'kill-akaza-on-contact', name: 'kill-akaza-on-contact', description: '', trigger: { type: 'afterPiecePathContact' },
      effect: (_battle, context) => {
        if (context.sourcePiece?.instanceId === akaza.instanceId) context.sourcePiece.currentHp = 0
        return { success: true }
      },
    })

    const result = runBattleAction(
      state,
      selectedAction(state, 'enemy', 5, 4),
      { rootSeed: ROOT_SEED },
    ).state as any
    const resultAkaza = result.graveyard?.find((piece: any) => piece.instanceId === 'akaza') || result.pieces.find((piece: any) => piece.instanceId === 'akaza')
    expect(resultAkaza?.attack ?? 4).toBe(4)
  })
})
