/* eslint-disable @typescript-eslint/no-explicit-any -- trigger queue audit uses minimal dynamic rule shapes */
import { describe, expect, it } from 'vitest'

import { TriggerSystem } from '@/lib/game/triggers'
import { makeState } from '../helpers/minimal-state'

type QueueScenario = {
  name: string
  install: (system: TriggerSystem, trace: string[]) => void
  first: string[]
  second: string[]
}

const scenarios: QueueScenario[] = [
  {
    name: 'a rule added during its category is visible only to the next event',
    install: (system, trace) => {
      let installed = false
      const added = {
        id: 'added', name: 'added', description: '', priority: 1, trigger: { type: 'dynamic' },
        effect: () => { trace.push('added'); return { success: true } },
      }
      system.addRule({
        id: 'adder', name: 'adder', description: '', priority: 2, trigger: { type: 'dynamic' },
        effect: () => {
          trace.push('adder')
          if (!installed) {
            installed = true
            system.addRule(added as any)
          }
          return { success: true }
        },
      } as any)
    },
    first: ['adder'],
    second: ['adder', 'added'],
  },
  {
    name: 'a rule removed during its category completes the current snapshot then disappears',
    install: (system, trace) => {
      system.addRules([
        {
          id: 'remover', name: 'remover', description: '', priority: 2, trigger: { type: 'dynamic' },
          effect: () => { trace.push('remover'); system.removeRule('removed'); return { success: true } },
        },
        {
          id: 'removed', name: 'removed', description: '', priority: 1, trigger: { type: 'dynamic' },
          effect: () => { trace.push('removed'); return { success: true } },
        },
      ] as any)
    },
    first: ['remover', 'removed'],
    second: ['remover'],
  },
]

describe('RED-45 snapshotted trigger queue visibility', () => {
  it.each(scenarios)('$name', ({ install, first, second }) => {
    const system = new TriggerSystem()
    const trace: string[] = []
    const state = makeState() as any
    install(system, trace)

    system.checkTriggers(state, { type: 'dynamic' } as any)
    expect(trace).toEqual(first)

    trace.length = 0
    system.checkTriggers(state, { type: 'dynamic' } as any)
    expect(trace).toEqual(second)
  })
})
