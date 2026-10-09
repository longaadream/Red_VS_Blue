/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-backed skill fixtures and reducer state are dynamic. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { loadRuleById } from '@/lib/game/skills'
import { isSinglePieceTargetAction, prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function json(path: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

function rule(id: string): any {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`Rule ${id} did not load`)
  return loaded
}

function fixture(
  skillId: string,
  target: { x: number; y: number },
  options: {
    caster?: { x: number; y: number }
    extraTargets?: Array<{ instanceId: string; x: number; y: number }>
  } = {},
) {
  const aizen = makePiece({
    instanceId: 'red250-aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red', faction: 'red',
    x: 1, y: 1, currentHp: 9, maxHp: 9, attack: 4,
  }) as any
  aizen.name = '蓝染惣右介'
  aizen.rules = [rule('rule-aizen-kyoka-rewrite'), rule('rule-aizen-kyoka-expire')]
  aizen.statusTags = [
    { id: 'red250-kyoka-public', type: 'aizen-kyoka-active', visible: false },
    {
      id: 'red250-kyoka-secret', type: 'aizen-kyoka-secret', visible: false,
      targetPieceId: 'red250-secret-ally', opponentPlayerId: 'player-blue',
    },
  ]
  const original = makePiece({
    instanceId: 'red250-secret-ally', ownerPlayerId: 'player-red', faction: 'red',
    x: 2, y: 1, currentHp: 10, maxHp: 10, attack: 3,
  }) as any
  const replacement = makePiece({
    instanceId: `red250-replacement-${target.x}-${target.y}`,
    ownerPlayerId: 'player-blue', faction: 'blue',
    x: target.x, y: target.y, currentHp: 10, maxHp: 10, attack: 3,
  }) as any
  const caster = makePiece({
    instanceId: 'red250-caster', ownerPlayerId: 'player-blue', faction: 'blue',
    x: options.caster?.x ?? 5, y: options.caster?.y ?? 1, currentHp: 10, maxHp: 10, attack: 4,
  }) as any
  const extraTargets = (options.extraTargets || []).map(extra => makePiece({
    instanceId: extra.instanceId, ownerPlayerId: 'player-blue', faction: 'blue',
    x: extra.x, y: extra.y, currentHp: 10, maxHp: 10, attack: 3,
  }) as any)
  caster.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({
    pieces: [aizen, original, replacement, caster, ...extraTargets], currentPlayerId: 'player-blue',
  }) as any
  state.players[1].actionPoints = 3
  state.skillsById[skillId] = json(`data/skills/${skillId}.json`)
  return { state, original, replacement, caster }
}

function startKyokaAction(state: any, caster: any, original: any, skillId: string): any {
  const base = {
    type: 'useBasicSkill' as const, playerId: 'player-blue' as const,
    pieceId: caster.instanceId, skillId,
  }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, got ${prepared.kind}`)
  return runBattleAction(state, {
    ...base, targetPieceId: original.instanceId,
    selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
  } as any, { rootSeed: 250 }).state as any
}

function submitReplacement(pending: any, replacement: any): any {
  return runBattleAction(pending, {
    type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: replacement.instanceId,
    selectionId: pending.pendingTargetSelection.selectionId,
    stateRevision: pending.pendingTargetSelection.stateRevision,
  } as any, { rootSeed: 250 }).state as any
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED250 Aizen target replacement geometry', () => {
  it.each([
    { label: 'diagonal offset (1,1)', x: 2, y: 2 },
    { label: 'diagonal offset (2,1)', x: 3, y: 2 },
  ])('does not trigger Kyoka for the area skill at $label', ({ x, y }) => {
    const { state, original, replacement, caster } = fixture('grimmjow-gran-rey-cero', { x, y })
    const resolved = startKyokaAction(state, caster, original, 'grimmjow-gran-rey-cero')
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(2)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === replacement.instanceId).currentHp).toBe(10)
    expect(resolved.players[1].actionPoints).toBe(1)
    const resolvedAizen = resolved.pieces.find((piece: any) => piece.instanceId === 'red250-aizen')
    expect(resolvedAizen.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'aizen-kyoka-active' }),
      expect.objectContaining({ type: 'aizen-kyoka-secret' }),
    ]))
  })

  it.each([
    { label: 'diagonal offset (1,1)', x: 2, y: 2 },
    { label: 'diagonal offset (2,1)', x: 3, y: 2 },
  ])('resolves a true single-target replacement at $label', ({ x, y }) => {
    const { state, original, replacement, caster } = fixture('fireball', { x, y })
    const pending = startKyokaAction(state, caster, original, 'fireball')
    expect(pending.pendingTargetSelection.candidates).toEqual([
      { type: 'piece', pieceId: replacement.instanceId },
    ])

    const resolved = submitReplacement(pending, replacement)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === replacement.instanceId).currentHp).toBe(4)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.players[1].actionPoints).toBe(2)
    expect(resolved.actions.filter((entry: any) => entry.type === 'useBasicSkill' && entry.payload?.skillId === 'fireball'))
      .toHaveLength(1)
  })

  it('allows a true single-target rewrite back to the original caster', () => {
    const { state, original, replacement, caster } = fixture(
      'fireball', { x: 4, y: 1 }, { caster: { x: 3, y: 1 } },
    )
    const pending = startKyokaAction(state, caster, original, 'fireball')
    expect(pending.pendingTargetSelection.candidates).toEqual(expect.arrayContaining([
      { type: 'piece', pieceId: replacement.instanceId },
      { type: 'piece', pieceId: caster.instanceId },
    ]))

    const resolved = submitReplacement(pending, caster)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === caster.instanceId).currentHp).toBe(4)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.players[1].actionPoints).toBe(2)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-aizen').statusTags)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'aizen-kyoka-active' }),
        expect.objectContaining({ type: 'aizen-kyoka-secret' }),
      ]))
  })

  it('rejects a replacement outside Aizen Manhattan range without mutating pending state', () => {
    const { state, original, replacement, caster } = fixture(
      'fireball', { x: 2, y: 2 },
      { extraTargets: [{ instanceId: 'red250-outside', x: 5, y: 2 }] },
    )
    const pending = startKyokaAction(state, caster, original, 'fireball')
    expect(pending.pendingTargetSelection.candidates).toEqual([
      { type: 'piece', pieceId: replacement.instanceId },
    ])
    const before = JSON.stringify(pending)
    expect(() => submitReplacement(pending, pending.pieces.find((piece: any) => piece.instanceId === 'red250-outside')))
      .toThrow()
    expect(JSON.stringify(pending)).toBe(before)
  })

  it('keeps legacy one-piece skills without range eligible for Kyoka', () => {
    const { state, caster } = fixture('fireball', { x: 2, y: 2 })
    const action = {
      type: 'useBasicSkill' as const, playerId: 'player-blue' as const,
      pieceId: caster.instanceId, skillId: 'fireball',
    }
    expect(isSinglePieceTargetAction(state, action)).toBe(true)
    const legacyDefinition = { ...state.skillsById.fireball, id: 'red250-legacy-single' }
    delete legacyDefinition.range
    state.skillsById[legacyDefinition.id] = legacyDefinition
    expect(isSinglePieceTargetAction(state, { ...action, skillId: legacyDefinition.id })).toBe(true)
  })
})
