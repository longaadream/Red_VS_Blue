import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyBattleAction } from '@/lib/game/turn'
import { loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())

function fixture(skillId: string, preserve: boolean) {
  const definition = JSON.parse(readFileSync(resolve('data/skills', `${skillId}.json`), 'utf8'))
  const source = makePiece({ instanceId: 'mover', x: 1, y: 1, moveRange: 7,
    skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }],
    statusTags: [{ type: 'momentum-core', stacks: 2, skillIds: [skillId] },
      ...(preserve ? [{ type: 'preserve-momentum', stacks: 1 }] : [])],
    rules: [loadRuleById('rule-momentum-consume')!],
  })
  source.momentum = 2
  const state = makeState({ pieces: [source], width: 8, height: 3, phase: 'action', currentPlayerId: 'player-red' })
  state.skillsById[skillId] = definition
  state.players[0].actionPoints = 2
  const action = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: source.instanceId, skillId }
  const prepared = prepareAction(state, action)
  if (prepared.kind !== 'needTarget') throw new Error('Expected dash selector')
  return { state, action: { ...action, targetX: 4, targetY: 1,
    selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } }
}

describe('RED-257 executed skill paths', () => {
  for (const skillId of ['sonic-spin-dash', 'shadow-ride-sweep']) {
    it.each([false, true])(`${skillId} counts the committed path after a before-position redirect (preserve=%s)`, preserve => {
      const { state, action } = fixture(skillId, preserve)
      globalTriggerSystem.addRule({ id: 'redirect-dash', name: 'redirect dash', description: '',
        trigger: { type: 'beforePiecePositionChange' }, effect: (_battle, context) => {
          if (context.movementKind !== 'dash') return { success: false }
          context.targetX = 3
          context.targetY = 1
          return { success: true }
        } })
      const next = applyBattleAction(state, action)
      const changed = next.actions?.find(entry => entry.type === 'positionChanged')
      expect(changed?.payload?.path).toEqual([{ x: 2, y: 1 }, { x: 3, y: 1 }])
      expect(next.pieces[0]).toMatchObject({ x: 3, y: 1, momentum: preserve ? 4 : 2 })
      expect(next.pieces[0].statusTags?.find(tag => tag.type === 'momentum-core')?.stacks).toBe(preserve ? 4 : 2)
      expect(state.pieces[0]).toMatchObject({ x: 1, y: 1, momentum: 2 })
    })
  }
})
