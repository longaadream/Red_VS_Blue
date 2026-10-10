/* eslint-disable @typescript-eslint/no-explicit-any -- exercises the JSON-authored skill through the battle runtime. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function json(path: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

function selectedAction(state: any, base: Record<string, unknown>, targetPieceId: string): any {
  const prepared = prepareAction(state, base as any)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return { ...base, targetPieceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-250 Ulquiorra Cero', () => {
  it('settles half of the caster attack as real damage', () => {
    const caster = makePiece({
      instanceId: 'ulquiorra-caster',
      templateId: 'dark-ulquiorra',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      attack: 4,
    }) as any
    caster.skills = [{ skillId: 'ulquiorra-cero', currentCooldown: 0, usesRemaining: -1 }]
    const target = makePiece({
      instanceId: 'cero-target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 0,
      currentHp: 30,
      maxHp: 30,
    }) as any
    const state = makeState({ pieces: [caster, target] }) as any
    state.skillsById['ulquiorra-cero'] = json('data/skills/ulquiorra-cero.json')

    const action = selectedAction(state, {
      type: 'useBasicSkill',
      playerId: caster.ownerPlayerId,
      pieceId: caster.instanceId,
      skillId: 'ulquiorra-cero',
    }, target.instanceId)
    const resolved = runBattleAction(state, action, { rootSeed: 250 }).state as any

    expect(resolved.pieces.find((piece: any) => piece.instanceId === target.instanceId)?.currentHp).toBe(28)
    expect(resolved.actions).toContainEqual(expect.objectContaining({
      type: 'damage',
      payload: expect.objectContaining({ skillId: 'ulquiorra-cero', finalDamage: 2 }),
    }))
  })
})
