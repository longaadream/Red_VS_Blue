import { describe, expect, it } from 'vitest'
import type { BattleState } from '@/lib/game/turn'
import { TriggerSystem, type TriggerContext, type TriggerResult, type TriggerRule } from '@/lib/game/triggers'
import { makeState } from '../helpers/minimal-state'

const testRule = (id: string, type: string, effect: TriggerRule['effect']): TriggerRule => ({
  id,
  name: id,
  description: id,
  trigger: { type },
  effect,
})

describe('RED-62 fireEvent chain protection', () => {
  it('records parent-child metadata for nested dispatches', () => {
    const system = new TriggerSystem()
    const state = makeState()
    const parentContext: TriggerContext = { type: 'parent' }
    system.addRules([
      testRule('parent', 'parent', () => system.fireEvent(state, parentContext, 'child')),
      testRule('child', 'child', () => ({ success: true })),
    ])

    const result = system.checkTriggers(state, parentContext)

    expect(result.eventChain).toEqual([
      expect.objectContaining({ eventId: 'event-1:1', type: 'parent', depth: 0 }),
      expect.objectContaining({ eventId: 'event-1:2', parentEventId: 'event-1:1', type: 'child', depth: 1 }),
    ])
  })

  it('stops recursive chains at depth 20 and includes the accepted chain', () => {
    const system = new TriggerSystem()
    const state = makeState()
    system.addRules([testRule('loop', 'loop', (_battle: BattleState, context: TriggerContext) => {
        if ((context.eventDepth ?? 0) < 19) return system.fireEvent(state, context, 'loop')
        return { success: true }
      })])

    const parentContext: TriggerContext = { type: 'loop' }
    const result = system.checkTriggers(state, parentContext)

    expect(result.eventChain).toHaveLength(20)
    const terminal = system.fireEvent(state, {
      type: 'loop', eventId: 'event-1:20', rootEventId: 'event-1', eventDepth: 19,
      eventChain: parentContext.eventChain,
    }, 'loop')
    expect(terminal.error).toMatchObject({ code: 'EVENT_CHAIN_DEPTH_EXCEEDED' })
    expect(terminal.error?.eventChain).toHaveLength(20)
  })

  it('stops wide chains at the 100-dispatch budget', () => {
    const system = new TriggerSystem()
    const state = makeState()
    const children: TriggerResult[] = []
    system.addRules([
      testRule('root', 'root', (_battle: BattleState, context: TriggerContext) => {
        for (let index = 0; index < 100; index++) children.push(system.fireEvent(state, context, 'child'))
        return { success: true }
      }),
      testRule('child', 'child', () => ({ success: true })),
    ])

    const result = system.checkTriggers(state, { type: 'root' })

    const finalChild = children.at(-1)
    expect(finalChild?.error).toMatchObject({ code: 'EVENT_CHAIN_BUDGET_EXCEEDED' })
    expect(finalChild?.error?.eventChain).toHaveLength(100)
    expect(result.eventChain).toHaveLength(100)
  })
})
