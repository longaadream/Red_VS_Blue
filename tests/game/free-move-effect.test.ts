import { beforeEach, describe, expect, it } from 'vitest'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())

describe('effect-granted ordinary movement', () => {
  it('runs movement reactions, respects their destination and spends no AP', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'mover', x: 1, y: 1,
      rules: [
        { id: 'redirect', trigger: { type: 'beforeMove' }, effect: (_battle, context) => {
          context.targetX = 3
          return { success: true, message: '' }
        } },
        { id: 'after', trigger: { type: 'afterMove' }, effect: (battle) => {
          battle.extensions!.moveCount = Number(battle.extensions!.moveCount || 0) + 1
          return { success: true, message: '' }
        } },
      ],
    })], currentPlayerId: 'player-blue' })
    state.players[0].actionPoints = 0
    const flow = createFlowRuntime(state, {}, 'pending', {})
    expect(flow.query.normalMoveTargets('mover')).toContainEqual({ x: 2, y: 1 })
    expect(flow.effects.freeMove('mover', { x: 2, y: 1 }).success).toBe(true)
    expect(state.pieces[0]).toMatchObject({ x: 3, y: 1 })
    expect(state.players[0].actionPoints).toBe(0)
    expect(state.extensions!.moveCount).toBe(1)
    expect(state.actions?.filter(action => action.type === 'move')).toHaveLength(1)
  })

  it('does not bypass beforeMove blocks or execute afterMove after rejection', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'mover', x: 1, y: 1,
      rules: [{ id: 'block', trigger: { type: 'beforeMove' }, effect: () => ({ success: true, blocked: true, message: 'blocked' }) }],
    })] })
    const flow = createFlowRuntime(state, {}, 'pending', {})
    expect(flow.effects.freeMove('mover', { x: 2, y: 1 })).toMatchObject({ success: false })
    expect(state.pieces[0]).toMatchObject({ x: 1, y: 1 })
    expect(state.actions?.some(action => action.type === 'move')).not.toBe(true)
  })

  it('revalidates redirected movement against ordinary path blockers', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'mover', x: 1, y: 1,
      rules: [{ id: 'redirect', trigger: { type: 'beforeMove' }, effect: (_battle, context) => {
        context.targetX = 4
        return { success: true, message: '' }
      } }],
    }), makePiece({ instanceId: 'blocker', x: 3, y: 1 })] })
    const flow = createFlowRuntime(state, {}, 'pending', {})
    expect(flow.effects.freeMove('mover', { x: 2, y: 1 }).success).toBe(false)
    expect(state.pieces[0]).toMatchObject({ x: 1, y: 1 })
  })

  it('follows an authoritative corner route for a diagonal destination', () => {
    let afterMovePath: { pathCells?: unknown; contactCells?: unknown } | undefined
    const state = makeState({ pieces: [makePiece({ instanceId: 'mover', x: 1, y: 1, moveRange: 3,
      rules: [{ id: 'after-path', trigger: { type: 'afterMove' }, effect: (_battle, context) => {
        afterMovePath = { pathCells: context.pathCells, contactCells: context.contactCells }
        return { success: true, message: '' }
      } }],
    })] })
    const flow = createFlowRuntime(state, {}, 'pending', {})
    const expectedPath = [{ x: 2, y: 1 }, { x: 2, y: 2 }]

    expect(flow.query.normalMoveTargets('mover')).toContainEqual({ x: 2, y: 2 })
    expect(flow.effects.freeMove('mover', { x: 2, y: 2 })).toMatchObject({ success: true })
    expect(state.pieces[0]).toMatchObject({ x: 2, y: 2 })
    expect(state.actions?.find(action => action.type === 'positionChanged')?.payload).toMatchObject({
      movementKind: 'walk', path: expectedPath,
    })
    expect(state.actions?.find(action => action.type === 'move')?.payload).toMatchObject({
      fromX: 1, fromY: 1, toX: 2, toY: 2, freeMove: true,
    })
    expect(afterMovePath).toEqual({ pathCells: expectedPath, contactCells: expectedPath })
  })
})
