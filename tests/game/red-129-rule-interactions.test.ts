/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise JSON-authored RED-129 rules. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { dealDamage, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 129

function namedPiece(overrides: Parameters<typeof makePiece>[0], name: string) {
  const piece = makePiece(overrides) as any
  piece.name = name
  return piece
}

function rule(id: string) {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`${id} did not load`)
  return loaded
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

function resolvePendingPiece(state: BattleState, targetPieceId: string): BattleState {
  const pending = state.pendingTargetSelection
  if (!pending) throw new Error('Expected pending target selection')
  return runBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: pending.playerId,
    targetPieceId,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  }, { rootSeed: ROOT_SEED }).state
}

function cancelPending(state: BattleState): BattleState {
  const pending = state.pendingTargetSelection
  if (!pending) throw new Error('Expected pending target selection')
  return runBattleAction(state, {
    type: 'cancelPendingSelection',
    playerId: pending.playerId,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  }, { rootSeed: ROOT_SEED }).state
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-129 无限刃 pending 二段', () => {
  function shishioState(firstHp = 10) {
    const shishio = namedPiece({
      instanceId: 'shishio',
      templateId: 'red-shishio',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      currentHp: 7,
      maxHp: 7,
      attack: 4,
    }, '志志雄真实')
    const first = namedPiece({
      instanceId: 'first',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: firstHp,
      maxHp: firstHp,
    }, '第一目标')
    const second = namedPiece({
      instanceId: 'second',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 2,
      currentHp: 10,
      maxHp: 10,
    }, '第二目标')
    const state = makeState({
      pieces: [shishio, first, second],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 6,
      height: 5,
    }) as any
    state.players[0].actionPoints = 2
    installSkill(state, shishio, 'shishio-infinite-blade')
    return { state, shishio, first, second }
  }

  it('keeps the root atomic, spends AP once, and resolves or cancels the optional second strike', () => {
    const { state } = shishioState()
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'shishio',
      skillId: 'shishio-infinite-blade',
    }, 'first')
    const pending = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(pending.pendingTargetSelection).toMatchObject({
      playerId: 'player-red',
      source: { type: 'skill', id: 'shishio-infinite-blade', pieceId: 'shishio' },
      canCancel: true,
    })
    expect(pending.players[0].actionPoints).toBe(2)
    expect(pending.pieces.find(piece => piece.instanceId === 'shishio')?.currentHp).toBe(7)
    expect(pending.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(10)
    expect((pending.actions ?? []).filter(entry => entry.type === 'useBasicSkill')).toHaveLength(0)

    const resolved = resolvePendingPiece(pending, 'second')
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.pieces.find(piece => piece.instanceId === 'shishio')?.currentHp).toBe(6)
    expect(resolved.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(6)
    expect(resolved.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(6)
    expect(resolved.pieces.find(piece => piece.instanceId === 'shishio')?.skills)
      .not.toContainEqual(expect.objectContaining({ skillId: 'shishio-infinite-blade-recast' }))
    expect((resolved.actions ?? []).filter(entry => entry.type === 'useBasicSkill')).toHaveLength(1)

    const cancelled = cancelPending(pending)
    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[0].actionPoints).toBe(1)
    expect(cancelled.pieces.find(piece => piece.instanceId === 'shishio')?.currentHp).toBe(7)
    expect(cancelled.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(6)
    expect(cancelled.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(10)
    expect((cancelled.actions ?? []).filter(entry => entry.type === 'useBasicSkill')).toHaveLength(1)
  })

  it('recalculates the second strike after a first-strike kill increases the multiplier', () => {
    const { state, shishio } = shishioState(4)
    shishio.rules = [rule('rule-shishio-kill-track')]
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'shishio',
      skillId: 'shishio-infinite-blade',
    }, 'first')
    const pending = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const candidates = pending.pendingTargetSelection?.candidates || []

    expect(candidates).toContainEqual({ type: 'piece', pieceId: 'second' })
    expect(candidates).not.toContainEqual({ type: 'piece', pieceId: 'first' })

    const resolved = resolvePendingPiece(pending, 'second')
    expect(resolved.graveyard.some(piece => piece.instanceId === 'first')).toBe(true)
    expect(resolved.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(4)
    expect(resolved.pieces.find(piece => piece.instanceId === 'shishio')?.statusTags)
      .toContainEqual(expect.objectContaining({ type: 'shishio-kills', intensity: 1 }))
  })

  it('does not attack after paying the second-stage life cost kills Shishio', () => {
    const { state, shishio } = shishioState()
    shishio.currentHp = 1
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'shishio',
      skillId: 'shishio-infinite-blade',
    }, 'first')
    const pending = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const resolved = resolvePendingPiece(pending, 'second')

    expect(resolved.graveyard.some(piece => piece.instanceId === 'shishio')).toBe(true)
    expect(resolved.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(10)
    expect(resolved.players[0].actionPoints).toBe(1)
  })
})

describe('RED-129 提里奥圣盾生命周期', () => {
  it('starts shielded, gains attack whenever the shield breaks, and can recall it for 1 AP', () => {
    const tirion = namedPiece({
      instanceId: 'tirion',
      templateId: 'blue-tirion-fordring',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      currentHp: 15,
      maxHp: 15,
      attack: 5,
    }, '提里奥弗丁')
    tirion.rules = [
      rule('rule-tirion-divine-shield-start'),
      rule('rule-tirion-divine-glory'),
    ]
    const enemy = namedPiece({
      instanceId: 'enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      attack: 8,
    }, '敌人')
    const state = makeState({
      pieces: [tirion, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
    }) as any

    const start = globalTriggerSystem.checkTriggers(state, {
      type: 'gameStart',
      playerId: 'player-red',
      turnNumber: 1,
    } as any)
    expect(start.success).toBe(true)
    expect(tirion.statusTags).toContainEqual(expect.objectContaining({ type: 'divine-shield' }))
    expect(tirion.rules).toContainEqual(expect.objectContaining({ id: 'rule-divine-shield' }))
    expect(tirion.attack).toBe(5)

    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 1 }), () => {
      dealDamage(enemy, tirion, 8, 'true', state, 'break-first-shield')
    })
    expect(tirion.currentHp).toBe(15)
    expect(tirion.statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(false)
    expect(tirion.attack).toBe(6)

    state.players[0].actionPoints = 2
    installSkill(state, tirion, 'tirion-holy-recall')
    const recalled = runBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'tirion',
      skillId: 'tirion-holy-recall',
    }, { rootSeed: ROOT_SEED }).state
    const recalledTirion = recalled.pieces.find(piece => piece.instanceId === 'tirion')!

    expect(recalled.players[0].actionPoints).toBe(1)
    expect(recalledTirion.skills.find(entry => entry.skillId === 'tirion-holy-recall')?.currentCooldown).toBe(2)
    expect(recalledTirion.statusTags).toContainEqual(expect.objectContaining({ type: 'divine-shield' }))

    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 2 }), () => {
      dealDamage(
        recalled.pieces.find(piece => piece.instanceId === 'enemy')!,
        recalledTirion,
        8,
        'true',
        recalled,
        'break-second-shield',
      )
    })
    expect(recalledTirion.currentHp).toBe(15)
    expect(recalledTirion.attack).toBe(7)
  })
})

describe('RED-129 波风水门回合结束锚点', () => {
  function minatoEndTurnState() {
    const minato = namedPiece({
      instanceId: 'minato',
      templateId: 'blue-minato',
      ownerPlayerId: 'player-red',
      x: 3,
      y: 3,
    }, '波风水门')
    minato.rules = [rule('rule-minato-anchor-end-turn')]
    const state = makeState({
      pieces: [minato],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 8,
      height: 8,
    }) as any
    return { state, minato }
  }

  it('opens a mandatory atomic target pending and commits one anchor after selection', () => {
    const { state } = minatoEndTurnState()
    const beforeHash = hashBattleState(state)
    const pending = runBattleAction(state, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state

    expect(pending.pendingTargetSelection).toMatchObject({
      playerId: 'player-red',
      source: { type: 'rule', id: 'rule-minato-anchor-end-turn', pieceId: 'minato' },
      canCancel: false,
    })
    expect(pending.turn).toMatchObject({ currentPlayerId: 'player-red', phase: 'action' })
    expect(pending.extensions?.minatoAnchors || []).toEqual([])
    expect(hashBattleState(state)).toBe(beforeHash)

    const session = pending.pendingTargetSelection!
    const target = session.candidates?.find(candidate =>
      candidate.type === 'cell' && candidate.x === 4 && candidate.y === 3)
    if (!target || target.type !== 'cell') throw new Error('Expected legal anchor cell 4,3')
    const completed = runBattleAction(pending, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: target.x,
      targetY: target.y,
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    }, { rootSeed: ROOT_SEED }).state

    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.turn).toMatchObject({ currentPlayerId: 'player-red', phase: 'end' })
    expect(completed.extensions?.minatoAnchors).toContainEqual(
      expect.objectContaining({ sourceId: 'minato', ownerPlayerId: 'player-red', x: 4, y: 3 }),
    )
    expect((completed.extensions as any).tileEffects).toContainEqual(
      expect.objectContaining({ sourceId: 'minato', tileType: 'flying-raijin-anchor', x: 4, y: 3 }),
    )
  })

  it('does not offer an anchor when the opponent ends their turn', () => {
    const { state } = minatoEndTurnState()
    state.turn.currentPlayerId = 'player-blue'

    const completed = runBattleAction(state, {
      type: 'endTurn',
      playerId: 'player-blue',
    }, { rootSeed: ROOT_SEED }).state

    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.pendingOptionSelection).toBeUndefined()
    expect(completed.turn).toMatchObject({ currentPlayerId: 'player-blue', phase: 'end' })
    expect(completed.extensions?.minatoAnchors || []).toEqual([])
  })

  it('evicts the oldest anchor and its tile effect when a fourth anchor is placed', () => {
    const { state } = minatoEndTurnState()
    state.extensions.minatoAnchors = [
      { sourceId: 'minato', ownerPlayerId: 'player-red', x: 0, y: 0, createdAt: -3 },
      { sourceId: 'minato', ownerPlayerId: 'player-red', x: 0, y: 1, createdAt: -2 },
      { sourceId: 'minato', ownerPlayerId: 'player-red', x: 0, y: 2, createdAt: -1 },
    ] as any
    ;(state.extensions as any).tileEffects = [
      { sourceId: 'minato', tileType: 'flying-raijin-anchor', x: 0, y: 0 },
      { sourceId: 'minato', tileType: 'flying-raijin-anchor', x: 0, y: 1 },
      { sourceId: 'minato', tileType: 'flying-raijin-anchor', x: 0, y: 2 },
    ]

    const pending = runBattleAction(state, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state
    const session = pending.pendingTargetSelection!
    const completed = runBattleAction(pending, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 4,
      targetY: 3,
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    }, { rootSeed: ROOT_SEED }).state
    const anchors = (completed.extensions?.minatoAnchors || [])
      .filter((anchor: any) => anchor.sourceId === 'minato')
    const tileEffects = ((completed.extensions as any).tileEffects || [])
      .filter((effect: any) => effect.sourceId === 'minato' && effect.tileType === 'flying-raijin-anchor')

    expect(anchors).toHaveLength(3)
    expect(anchors).not.toContainEqual(expect.objectContaining({ x: 0, y: 0 }))
    expect(anchors).toContainEqual(expect.objectContaining({ x: 4, y: 3 }))
    expect(tileEffects).toHaveLength(3)
    expect(tileEffects).not.toContainEqual(expect.objectContaining({ x: 0, y: 0 }))
  })
})

describe('RED-129 毒液腐蚀定身', () => {
  it('blocks the displaced enemy next turn, expires at that turn end, then allows movement', () => {
    const venom = namedPiece({
      instanceId: 'venom',
      templateId: 'red-venom',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
    }, '毒液')
    const enemy = namedPiece({
      instanceId: 'corroded-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 0,
      moveRange: 3,
    }, '被腐蚀敌人')
    const state = makeState({
      pieces: [venom, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 6,
      height: 3,
    }) as any
    state.players.forEach((player: any) => {
      player.actionPoints = 2
      player.maxActionPoints = 2
    })
    installSkill(state, venom, 'venom-host-transfer')
    const swapped = runBattleAction(state, selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'venom',
      skillId: 'venom-host-transfer',
    }, 'corroded-enemy'), { rootSeed: ROOT_SEED }).state
    const corroded = swapped.pieces.find(piece => piece.instanceId === 'corroded-enemy')!

    expect(corroded).toMatchObject({ x: 0, y: 0 })
    expect(corroded.statusTags).toContainEqual(expect.objectContaining({
      type: 'venom-corrosion-immobile',
      currentDuration: 1,
      remainingDuration: 1,
    }))
    expect(corroded.rules).toContainEqual(expect.objectContaining({ id: 'rule-venom-corrosion-immobile' }))

    const redEnded = runBattleAction(swapped, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state
    const blueTurn = runBattleAction(redEnded, { type: 'beginPhase' }, { rootSeed: ROOT_SEED }).state
    expect(blueTurn.turn).toMatchObject({ currentPlayerId: 'player-blue', phase: 'action' })
    const blueApBeforeBlockedMove = blueTurn.players.find(player => player.playerId === 'player-blue')!.actionPoints

    const blocked = runBattleAction(blueTurn, {
      type: 'move',
      playerId: 'player-blue',
      pieceId: 'corroded-enemy',
      toX: 1,
      toY: 0,
    }, { rootSeed: ROOT_SEED }).state
    expect(blocked.pieces.find(piece => piece.instanceId === 'corroded-enemy')).toMatchObject({ x: 0, y: 0 })
    expect(blocked.players.find(player => player.playerId === 'player-blue')?.actionPoints).toBe(blueApBeforeBlockedMove)

    const blueEnded = runBattleAction(blocked, {
      type: 'endTurn',
      playerId: 'player-blue',
    }, { rootSeed: ROOT_SEED }).state
    const expired = blueEnded.pieces.find(piece => piece.instanceId === 'corroded-enemy')!
    expect(expired.statusTags).not.toContainEqual(expect.objectContaining({ type: 'venom-corrosion-immobile' }))
    expect(expired.rules).not.toContainEqual(expect.objectContaining({ id: 'rule-venom-corrosion-immobile' }))

    const redTurn = runBattleAction(blueEnded, { type: 'beginPhase' }, { rootSeed: ROOT_SEED }).state
    const nextRedEnd = runBattleAction(redTurn, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state
    const nextBlueTurn = runBattleAction(nextRedEnd, { type: 'beginPhase' }, { rootSeed: ROOT_SEED }).state
    const blueApBeforeLegalMove = nextBlueTurn.players.find(player => player.playerId === 'player-blue')!.actionPoints
    const moved = runBattleAction(nextBlueTurn, {
      type: 'move',
      playerId: 'player-blue',
      pieceId: 'corroded-enemy',
      toX: 1,
      toY: 0,
    }, { rootSeed: ROOT_SEED }).state

    expect(moved.pieces.find(piece => piece.instanceId === 'corroded-enemy')).toMatchObject({ x: 1, y: 0 })
    expect(moved.players.find(player => player.playerId === 'player-blue')?.actionPoints).toBe(blueApBeforeLegalMove - 1)
  })
})

describe('RED-129 拉法姆规则与资源', () => {
  function wardCurseState() {
    const rafaam = namedPiece({
      instanceId: 'curse-rafaam',
      templateId: 'red-rafaam',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      currentHp: 15,
      maxHp: 15,
      attack: 2,
    }, '拉法姆')
    rafaam.rules = [rule('rule-rafaam-curse-ward')]
    const blueA = namedPiece({
      instanceId: 'curse-blue-a',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 20,
      maxHp: 20,
    }, '蓝方甲')
    const blueB = namedPiece({
      instanceId: 'curse-blue-b',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 1,
      currentHp: 20,
      maxHp: 20,
    }, '蓝方乙')
    const state = makeState({
      pieces: [rafaam, blueA, blueB],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 6,
      height: 4,
    }) as any
    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 10 }), () => {
      dealDamage(blueA, rafaam, 5, 'true', state, 'curse-fixture-hit')
    })
    return { state, rafaam, blueA, blueB }
  }

  it('steals attack and returns it exactly at the target owner next end turn', () => {
    const rafaam = namedPiece({
      instanceId: 'rafaam',
      templateId: 'red-rafaam',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      attack: 0,
    }, '拉法姆')
    const target = namedPiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 4,
      y: 1,
      attack: 4,
    }, '目标')
    const state = makeState({
      pieces: [rafaam, target],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 8,
      height: 5,
    }) as any
    state.players[0].actionPoints = 2
    installSkill(state, rafaam, 'rafaam-temporal-distortion')
    const action = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'rafaam',
      skillId: 'rafaam-temporal-distortion',
    }, 'target')
    const stolen = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const blue = stolen.players.find(player => player.playerId === 'player-blue') as any

    expect(stolen.pieces.find(piece => piece.instanceId === 'rafaam')?.attack).toBe(4)
    expect(stolen.pieces.find(piece => piece.instanceId === 'target')?.attack).toBe(0)
    expect(stolen.players[0].actionPoints).toBe(1)
    expect(blue.statusTags).toContainEqual(expect.objectContaining({
      type: 'rafaam-temporal-distortion',
      intensity: 4,
      sourceId: 'rafaam',
      targetId: 'target',
    }))
    expect(blue.rules).toContainEqual(expect.objectContaining({ id: 'rule-rafaam-temporal-distortion' }))

    const redEnded = runBattleAction(stolen, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state
    expect(redEnded.pieces.find(piece => piece.instanceId === 'rafaam')?.attack).toBe(4)
    const blueAction = runBattleAction(redEnded, {
      type: 'beginPhase',
    }, { rootSeed: ROOT_SEED }).state
    expect(blueAction.turn).toMatchObject({ currentPlayerId: 'player-blue', phase: 'action' })
    const returned = runBattleAction(blueAction, {
      type: 'endTurn',
      playerId: 'player-blue',
    }, { rootSeed: ROOT_SEED }).state
    const returnedBlue = returned.players.find(player => player.playerId === 'player-blue') as any

    expect(returned.pieces.find(piece => piece.instanceId === 'rafaam')?.attack).toBe(0)
    expect(returned.pieces.find(piece => piece.instanceId === 'target')?.attack).toBe(4)
    expect(returnedBlue.statusTags || []).not.toContainEqual(
      expect.objectContaining({ type: 'rafaam-temporal-distortion' }),
    )
    expect(returnedBlue.rules || []).not.toContainEqual(
      expect.objectContaining({ id: 'rule-rafaam-temporal-distortion' }),
    )
  })

  it('immunizes only the first own-turn hit and creates a curse with damage plus current attack', () => {
    const rafaam = namedPiece({
      instanceId: 'rafaam',
      templateId: 'red-rafaam',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      currentHp: 15,
      maxHp: 15,
      attack: 2,
    }, '拉法姆')
    rafaam.rules = [rule('rule-rafaam-curse-ward')]
    const enemy = namedPiece({
      instanceId: 'enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
    }, '敌人')
    const state = makeState({
      pieces: [rafaam, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
    }) as any

    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 1 }), () => {
      dealDamage(enemy, rafaam, 5, 'true', state, 'first-hit')
      dealDamage(enemy, rafaam, 5, 'true', state, 'second-hit')
    })

    expect(rafaam.currentHp).toBe(10)
    expect(rafaam.statusTags.filter((tag: any) => tag.type === 'curse-ward-used')).toHaveLength(1)
    const blue = state.players.find((player: any) => player.playerId === 'player-blue') as any
    expect(blue.hand).toHaveLength(1)
    const curse = blue.hand[0]
    expect(curse.cardId).toMatch(/^rafaam-curse-/)
    expect((state as any).customCards[curse.cardId]).toMatchObject({
      id: curse.cardId,
      actionPointCost: 1,
      damageAmount: 7,
    })
  })

  it('lets the holder spend 1 AP to discard the dynamic curse without taking damage', () => {
    const { state, blueA, blueB } = wardCurseState()
    const blue = state.players.find((player: any) => player.playerId === 'player-blue')!
    const curse = blue.hand[0]
    const redEnded = runBattleAction(state, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state
    const blueTurn = runBattleAction(redEnded, { type: 'beginPhase' }, { rootSeed: ROOT_SEED }).state
    const actionPointsBefore = blueTurn.players.find(player => player.playerId === 'player-blue')!.actionPoints
    const hpBefore = [blueA.instanceId, blueB.instanceId].map(id =>
      blueTurn.pieces.find(piece => piece.instanceId === id)!.currentHp)

    const discarded = runBattleAction(blueTurn, {
      type: 'playCard',
      playerId: 'player-blue',
      cardInstanceId: curse.instanceId,
    }, { rootSeed: ROOT_SEED }).state
    const discardedBlue = discarded.players.find(player => player.playerId === 'player-blue')!

    expect(discardedBlue.actionPoints).toBe(actionPointsBefore - 1)
    expect(discardedBlue.hand).not.toContainEqual(expect.objectContaining({ instanceId: curse.instanceId }))
    expect(discardedBlue.discardPile).toContain(curse.cardId)
    expect([blueA.instanceId, blueB.instanceId].map(id =>
      discarded.pieces.find(piece => piece.instanceId === id)!.currentHp)).toEqual(hpBefore)
  })

  it('deals the recorded damage to exactly one deterministic ally and keeps an unplayed curse', () => {
    const { state, blueA, blueB } = wardCurseState()
    const redEnded = runBattleAction(state, {
      type: 'endTurn',
      playerId: 'player-red',
    }, { rootSeed: ROOT_SEED }).state
    const blueTurn = runBattleAction(redEnded, { type: 'beginPhase' }, { rootSeed: ROOT_SEED }).state
    for (const id of [blueA.instanceId, blueB.instanceId]) {
      const ally = blueTurn.pieces.find(piece => piece.instanceId === id)!
      ally.statusTags.push({
        id: `nano-${id}`,
        type: 'nano-boost',
        currentDuration: -1,
        currentUses: -1,
        intensity: 1,
      })
      ally.rules = [rule('rule-nano-boost-damage')]
    }
    const blue = blueTurn.players.find(player => player.playerId === 'player-blue')!
    const curse = blue.hand[0]
    const cardDef = (blueTurn as any).customCards[curse.cardId]
    expect(cardDef).toMatchObject({ damageAmount: 7, sourcePieceId: 'curse-rafaam' })

    const first = runBattleAction(blueTurn, {
      type: 'endTurn',
      playerId: 'player-blue',
    }, { rootSeed: ROOT_SEED }).state
    const second = runBattleAction(blueTurn, {
      type: 'endTurn',
      playerId: 'player-blue',
    }, { rootSeed: ROOT_SEED }).state
    const ids = [blueA.instanceId, blueB.instanceId]
    const firstHp = ids.map(id => first.pieces.find(piece => piece.instanceId === id)!.currentHp)
    const secondHp = ids.map(id => second.pieces.find(piece => piece.instanceId === id)!.currentHp)
    const losses = firstHp.map(hp => 20 - hp)

    expect(firstHp).toEqual(secondHp)
    expect(losses.reduce((sum, loss) => sum + loss, 0)).toBe(7)
    expect(losses.filter(loss => loss > 0)).toHaveLength(1)
    expect(first.players.find(player => player.playerId === 'player-blue')!.hand)
      .toContainEqual(expect.objectContaining({ instanceId: curse.instanceId }))
  })

  it('copies every opponent curse definition for 0 AP and 1 CP without changing their hand', () => {
    const rafaam = namedPiece({
      instanceId: 'rafaam',
      templateId: 'red-rafaam',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      attack: 0,
    }, '拉法姆')
    const state = makeState({
      pieces: [rafaam],
      currentPlayerId: 'player-red',
      phase: 'action',
    }) as any
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 1
    const blue = state.players[1] as any
    blue.hand = [
      { cardId: 'rafaam-curse-a', instanceId: 'curse-a', name: '诅咒(3)', actionPointCost: 1 },
      { cardId: 'rafaam-curse-b', instanceId: 'curse-b', name: '诅咒(8)', actionPointCost: 1 },
      { cardId: 'holy-heal', instanceId: 'ordinary', name: '圣光治疗', actionPointCost: 1 },
    ]
    state.customCards = {
      'rafaam-curse-a': {
        id: 'rafaam-curse-a',
        name: '诅咒(3)',
        type: 'reactive',
        actionPointCost: 1,
        damageAmount: 3,
        code: 'function executeCard() { return { success: true }; }',
      },
      'rafaam-curse-b': {
        id: 'rafaam-curse-b',
        name: '诅咒(8)',
        type: 'reactive',
        actionPointCost: 1,
        damageAmount: 8,
        code: 'function executeCard() { return { success: true }; }',
      },
    }
    installSkill(state, rafaam, 'rafaam-curse-amplify')
    const beforeBlueHand = JSON.stringify(blue.hand)
    const result = runBattleAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'rafaam',
      skillId: 'rafaam-curse-amplify',
    }, { rootSeed: ROOT_SEED }).state
    const red = result.players.find(player => player.playerId === 'player-red') as any
    const copiedIds = red.hand.map((card: any) => card.cardId)
    const copiedDamage = copiedIds
      .map((id: string) => (result as any).customCards[id]?.damageAmount)
      .sort((a: number, b: number) => a - b)

    expect(red.actionPoints).toBe(2)
    expect(red.chargePoints).toBe(0)
    expect(red.hand).toHaveLength(2)
    expect(new Set(copiedIds).size).toBe(2)
    expect(copiedDamage).toEqual([3, 8])
    expect(JSON.stringify(result.players[1].hand)).toBe(beforeBlueHand)
  })
})
