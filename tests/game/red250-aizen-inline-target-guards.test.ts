/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-backed skills and pending target sessions are dynamic. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 250

function json(path: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

function rule(id: string): any {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`Rule ${id} did not load`)
  return loaded
}

type Position = { x: number; y: number }

function mirrorFixture(
  skillId: 'blackwidow-deadly-gaze' | 'venom-host-transfer',
  positions: {
    aizen: Position
    original: Position
    caster: Position
    replacement?: Position
  },
): any {
  const aizen = makePiece({
    instanceId: 'red250-inline-aizen',
    templateId: 'dark-aizen',
    ownerPlayerId: 'player-red',
    faction: 'red',
    ...positions.aizen,
    currentHp: 9,
    maxHp: 9,
    attack: 4,
  }) as any
  aizen.name = '蓝染惣右介'
  aizen.rules = [rule('rule-aizen-kyoka-rewrite'), rule('rule-aizen-kyoka-expire')]
  aizen.statusTags = [
    { id: 'red250-inline-public', type: 'aizen-kyoka-active', visible: false },
    {
      id: 'red250-inline-secret',
      type: 'aizen-kyoka-secret',
      visible: false,
      targetPieceId: 'red250-inline-original',
      opponentPlayerId: 'player-blue',
    },
  ]

  const original = makePiece({
    instanceId: 'red250-inline-original',
    ownerPlayerId: 'player-red',
    faction: 'red',
    ...positions.original,
    currentHp: 10,
    maxHp: 10,
    attack: 3,
  }) as any
  const caster = makePiece({
    instanceId: 'red250-inline-caster',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    ...positions.caster,
    currentHp: 10,
    maxHp: 10,
    attack: 4,
  }) as any
  const replacement = positions.replacement
    ? makePiece({
        instanceId: 'red250-inline-replacement',
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        ...positions.replacement,
        currentHp: 10,
        maxHp: 10,
        attack: 3,
      }) as any
    : undefined

  const state = makeState({
    pieces: [aizen, original, caster, ...(replacement ? [replacement] : [])],
    currentPlayerId: 'player-blue',
    width: 12,
    height: 8,
  }) as any
  state.players[1].actionPoints = 3
  state.players[1].chargePoints = skillId === 'blackwidow-deadly-gaze' ? 2 : 0
  caster.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
  state.skillsById[skillId] = json(`data/skills/${skillId}.json`)
  return { state, aizen, original, caster, replacement }
}

function ordinaryFixture(
  skillId: 'blackwidow-deadly-gaze' | 'venom-host-transfer',
  casterPosition: Position,
  targetPosition: Position,
): any {
  const caster = makePiece({
    instanceId: 'red250-ordinary-caster',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    ...casterPosition,
    currentHp: 10,
    maxHp: 10,
    attack: 4,
  }) as any
  const target = makePiece({
    instanceId: 'red250-ordinary-target',
    ownerPlayerId: 'player-red',
    faction: 'red',
    ...targetPosition,
    currentHp: 10,
    maxHp: 10,
  }) as any
  const state = makeState({
    pieces: [caster, target],
    currentPlayerId: 'player-blue',
    width: 12,
    height: 8,
  }) as any
  state.players[1].actionPoints = 3
  state.players[1].chargePoints = skillId === 'blackwidow-deadly-gaze' ? 2 : 0
  caster.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
  state.skillsById[skillId] = json(`data/skills/${skillId}.json`)
  return { state, caster, target }
}

function withTargetCredentials(state: any, base: any, targetPieceId: string): any {
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected needTarget, got ${prepared.kind}`)
  return {
    ...base,
    targetPieceId,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function startMirrorPending(state: any, caster: any, skillId: string, original: any): any {
  const type = skillId === 'blackwidow-deadly-gaze' ? 'useChargeSkill' : 'useBasicSkill'
  const base = { type, playerId: 'player-blue', pieceId: caster.instanceId, skillId }
  return runBattleAction(state, withTargetCredentials(state, base, original.instanceId), { rootSeed: ROOT_SEED }).state as any
}

function answerMirror(pending: any, targetPieceId: string): any {
  const selection = pending.pendingTargetSelection
  if (!selection) throw new Error('Expected mirror pending target selection')
  return runBattleAction(pending, {
    type: 'pendingTargetSelect',
    playerId: selection.playerId,
    targetPieceId,
    selectionId: selection.selectionId,
    stateRevision: selection.stateRevision,
  } as any, { rootSeed: ROOT_SEED }).state as any
}

function cancelMirror(pending: any): any {
  const selection = pending.pendingTargetSelection
  if (!selection) throw new Error('Expected mirror pending target selection')
  return runBattleAction(pending, {
    type: 'cancelPendingSelection',
    playerId: selection.playerId,
    selectionId: selection.selectionId,
    stateRevision: selection.stateRevision,
  } as any, { rootSeed: ROOT_SEED }).state as any
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED250 Aizen inline target guards', () => {
  it('allows a charge-skill mirror answer whose replacement is close to Black Widow', () => {
    const { state, original, caster, replacement } = mirrorFixture('blackwidow-deadly-gaze', {
      aizen: { x: 4, y: 0 },
      original: { x: 0, y: 0 },
      caster: { x: 7, y: 0 },
      replacement: { x: 4, y: 1 },
    })
    const pending = startMirrorPending(state, caster, 'blackwidow-deadly-gaze', original)
    expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red' })
    expect(pending.pendingTargetSelection.candidates).toContainEqual({ type: 'piece', pieceId: replacement.instanceId })

    const resolved = answerMirror(pending, replacement.instanceId)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === replacement.instanceId).currentHp).toBe(2)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.players[1]).toMatchObject({ actionPoints: 2, chargePoints: 0 })
    expect(resolved.actions.filter((entry: any) => entry.type === 'useChargeSkill' && entry.payload?.skillId === 'blackwidow-deadly-gaze'))
      .toHaveLength(1)
  })

  it('allows a charge-skill mirror answer back to Black Widow original caster', () => {
    const { state, original, caster } = mirrorFixture('blackwidow-deadly-gaze', {
      aizen: { x: 4, y: 0 },
      original: { x: 0, y: 0 },
      caster: { x: 7, y: 0 },
    })
    const pending = startMirrorPending(state, caster, 'blackwidow-deadly-gaze', original)
    expect(pending.pendingTargetSelection.candidates).toContainEqual({ type: 'piece', pieceId: caster.instanceId })

    const resolved = answerMirror(pending, caster.instanceId)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === caster.instanceId).currentHp).toBe(2)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.players[1]).toMatchObject({ actionPoints: 2, chargePoints: 0 })
    expect(resolved.actions.filter((entry: any) => entry.type === 'useChargeSkill' && entry.payload?.skillId === 'blackwidow-deadly-gaze'))
      .toHaveLength(1)
  })

  it('retains Black Widow ordinary minimum distance targeting', () => {
    const { state, caster, target } = ordinaryFixture('blackwidow-deadly-gaze', { x: 7, y: 0 }, { x: 4, y: 1 })
    const action = withTargetCredentials(state, {
      type: 'useChargeSkill', playerId: 'player-blue', pieceId: caster.instanceId,
      skillId: 'blackwidow-deadly-gaze',
    }, target.instanceId)
    expect(() => runBattleAction(state, action, { rootSeed: ROOT_SEED })).toThrow()
    expect(state.players[1]).toMatchObject({ actionPoints: 3, chargePoints: 2 })
    expect(target.currentHp).toBe(10)
  })

  it('allows Venom to mirror a target outside its seven-cell caster range', () => {
    const { state, original, caster, replacement } = mirrorFixture('venom-host-transfer', {
      aizen: { x: 1, y: 0 },
      original: { x: 0, y: 0 },
      caster: { x: 7, y: 0 },
      replacement: { x: 1, y: 2 },
    })
    const pending = startMirrorPending(state, caster, 'venom-host-transfer', original)
    expect(pending.pendingTargetSelection.candidates).toEqual([
      { type: 'piece', pieceId: replacement.instanceId },
    ])

    const resolved = answerMirror(pending, replacement.instanceId)
    const resolvedCaster = resolved.pieces.find((piece: any) => piece.instanceId === caster.instanceId)
    const resolvedReplacement = resolved.pieces.find((piece: any) => piece.instanceId === replacement.instanceId)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolvedCaster).toMatchObject({ x: 1, y: 2 })
    expect(resolvedReplacement).toMatchObject({ x: 7, y: 0 })
    expect(resolved.players[1].actionPoints).toBe(2)
    expect(resolvedCaster.skills).toContainEqual(expect.objectContaining({ skillId: 'venom-host-transfer', currentCooldown: 1 }))
    expect(resolved.actions.filter((entry: any) => entry.type === 'useBasicSkill' && entry.payload?.skillId === 'venom-host-transfer'))
      .toHaveLength(1)
  })

  it('treats a Venom mirror answer targeting the original caster as one successful no-op', () => {
    const { state, original, caster } = mirrorFixture('venom-host-transfer', {
      aizen: { x: 4, y: 0 },
      original: { x: 0, y: 0 },
      caster: { x: 7, y: 0 },
    })
    const pending = startMirrorPending(state, caster, 'venom-host-transfer', original)
    expect(pending.pendingTargetSelection.candidates).toContainEqual({ type: 'piece', pieceId: caster.instanceId })

    const before = {
      caster: { x: caster.x, y: caster.y },
      original: { x: original.x, y: original.y },
      tags: JSON.stringify(caster.statusTags),
    }
    const resolved = answerMirror(pending, caster.instanceId)
    const resolvedCaster = resolved.pieces.find((piece: any) => piece.instanceId === caster.instanceId)
    const resolvedOriginal = resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolvedCaster).toMatchObject(before.caster)
    expect(resolvedOriginal).toMatchObject(before.original)
    expect(JSON.stringify(resolvedCaster.statusTags)).toBe(before.tags)
    expect(resolved.players[1].actionPoints).toBe(2)
    expect(resolvedCaster.skills).toContainEqual(expect.objectContaining({ skillId: 'venom-host-transfer', currentCooldown: 1 }))
    expect(resolved.actions.filter((entry: any) => entry.type === 'useBasicSkill' && entry.payload?.skillId === 'venom-host-transfer'))
      .toHaveLength(1)
  })

  it('retains Venom ordinary self and out-of-range rejection', () => {
    const selfCase = ordinaryFixture('venom-host-transfer', { x: 0, y: 0 }, { x: 0, y: 0 })
    const selfAction = withTargetCredentials(selfCase.state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: selfCase.caster.instanceId,
      skillId: 'venom-host-transfer',
    }, selfCase.caster.instanceId)
    expect(() => runBattleAction(selfCase.state, selfAction, { rootSeed: ROOT_SEED })).toThrow()
    expect(selfCase.state.players[1].actionPoints).toBe(3)

    const farCase = ordinaryFixture('venom-host-transfer', { x: 0, y: 0 }, { x: 8, y: 0 })
    const farAction = withTargetCredentials(farCase.state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: farCase.caster.instanceId,
      skillId: 'venom-host-transfer',
    }, farCase.target.instanceId)
    expect(() => runBattleAction(farCase.state, farAction, { rootSeed: ROOT_SEED })).toThrow()
    expect(farCase.state.players[1].actionPoints).toBe(3)
    expect(farCase.target).toMatchObject({ x: 8, y: 0 })
  })

  it.each([
    ['blackwidow-deadly-gaze', { x: 4, y: 0 }, { x: 0, y: 0 }, { x: 7, y: 0 }],
    ['venom-host-transfer', { x: 4, y: 0 }, { x: 0, y: 0 }, { x: 7, y: 0 }],
  ] as const)('cancelling %s mirror selection preserves the original root action', (skillId, aizen, originalPosition, casterPosition) => {
    const { state, original, caster } = mirrorFixture(skillId, {
      aizen,
      original: originalPosition,
      caster: casterPosition,
    })
    const pending = startMirrorPending(state, caster, skillId, original)
    const cancelled = cancelMirror(pending)
    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[1]).toMatchObject({ actionPoints: 2, chargePoints: skillId === 'blackwidow-deadly-gaze' ? 0 : 0 })
    expect(cancelled.actions.filter((entry: any) => entry.type === (skillId === 'blackwidow-deadly-gaze' ? 'useChargeSkill' : 'useBasicSkill'))).toHaveLength(1)
    if (skillId === 'blackwidow-deadly-gaze') {
      expect(cancelled.pieces.find((piece: any) => piece.instanceId === original.instanceId)).toMatchObject({ currentHp: 2 })
    } else {
      expect(cancelled.pieces.find((piece: any) => piece.instanceId === caster.instanceId)).toMatchObject({ x: 0, y: 0 })
      expect(cancelled.pieces.find((piece: any) => piece.instanceId === original.instanceId)).toMatchObject({ x: 7, y: 0 })
      expect(cancelled.pieces.find((piece: any) => piece.instanceId === caster.instanceId).skills)
        .toContainEqual(expect.objectContaining({ skillId, currentCooldown: 1 }))
    }
  })

  it.each([
    ['blackwidow-deadly-gaze', { x: 4, y: 0 }, { x: 0, y: 0 }, { x: 7, y: 0 }, 'red250-inline-forged-blackwidow'],
    ['venom-host-transfer', { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 7, y: 0 }, 'red250-inline-forged-venom'],
  ] as const)('rejects an answer outside the private mirror candidates atomically for %s', (skillId, aizen, originalPosition, casterPosition, forgedId) => {
    const { state, original, caster } = mirrorFixture(skillId, {
      aizen,
      original: originalPosition,
      caster: casterPosition,
      ...(skillId === 'venom-host-transfer' ? { replacement: { x: 1, y: 2 } } : {}),
    })
    const forged = makePiece({
      instanceId: forgedId,
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 5,
      currentHp: 10,
      maxHp: 10,
    }) as any
    state.pieces.push(forged)
    const pending = startMirrorPending(state, caster, skillId, original)
    expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red' })
    expect(pending.pendingTargetSelection.candidates.length).toBeGreaterThan(0)
    expect(pending.pendingTargetSelection.candidates).not.toContainEqual({ type: 'piece', pieceId: forgedId })
    const before = JSON.stringify(pending)
    const pendingResources = {
      actionPoints: pending.players[1].actionPoints,
      chargePoints: pending.players[1].chargePoints,
    }
    expect(() => answerMirror(pending, forged.instanceId)).toThrow()
    expect(JSON.stringify(pending)).toBe(before)
    expect(pending.players[1]).toMatchObject(pendingResources)
  })
})
