import { describe, expect, it } from 'vitest'
import { cloneBattleStateJson } from '@/lib/game/clone-battle-json'

describe('cloneBattleStateJson', () => {
  it('keeps pure skills independent while preserving JSON output', () => {
    const shared = { nested: { value: 1 } }
    const state = {
      marker: { turn: 4 },
      skillsById: {
        alpha: {
          code: 'alpha',
          negativeZero: -0,
          left: shared,
          right: shared,
          steps: [{ amount: 2 }],
        },
        beta: { code: 'beta' },
        unvisited: { code: 'unvisited' },
      },
    }

    const expected = JSON.parse(JSON.stringify(state)) as typeof state
    const cloned = cloneBattleStateJson(state)

    expect(cloned).toEqual(expected)
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(expected))
    expect(Object.is(cloned.skillsById.alpha.negativeZero, 0)).toBe(true)
    expect(cloned.skillsById.alpha.left).not.toBe(cloned.skillsById.alpha.right)
    expect(cloned.skillsById.alpha.left).not.toBe(shared)
    expect(Object.keys(cloned.skillsById)).toEqual(['alpha', 'beta', 'unvisited'])

    cloned.skillsById.alpha.left.nested.value = 9
    expect(cloned.skillsById.alpha.right.nested.value).toBe(1)
    expect(shared.nested.value).toBe(1)
  })

  it('preserves getter evaluation order around skillsById', () => {
    const createState = () => {
      const skillsById = { skill: { code: 'initial' } }
      const state: Record<string, unknown> = {}
      Object.defineProperty(state, 'before', {
        configurable: true,
        enumerable: true,
        get: () => {
          skillsById.skill.code = 'before'
          return true
        },
      })
      Object.defineProperty(state, 'skillsById', {
        configurable: true,
        enumerable: true,
        value: skillsById,
        writable: true,
      })
      Object.defineProperty(state, 'after', {
        configurable: true,
        enumerable: true,
        get: () => {
          skillsById.skill.code = 'after'
          return true
        },
      })
      return { state, skillsById }
    }

    const baseline = createState()
    const expected = JSON.parse(JSON.stringify(baseline.state)) as typeof baseline.state
    const optimized = createState()
    const cloned = cloneBattleStateJson(optimized.state) as typeof optimized.state & {
      skillsById: { skill: { code: string } }
    }

    expect(cloned).toEqual(expected)
    expect(cloned.skillsById.skill.code).toBe('before')
    expect(optimized.skillsById.skill.code).toBe('after')
  })

  type FallbackCase = {
    label: string
    create: () => { state: Record<string, unknown>; calls?: () => number }
  }
  const fallbackCases: FallbackCase[] = [
    { label: 'undefined', create: () => ({ state: { skillsById: { value: undefined } } }) },
    { label: 'function', create: () => ({ state: { skillsById: { value: () => 1 } } }) },
    { label: 'Date', create: () => ({ state: { skillsById: { value: new Date('2024-01-02T03:04:05.000Z') } } }) },
    { label: 'NaN', create: () => ({ state: { skillsById: { value: Number.NaN } } }) },
    {
      label: 'toJSON',
      create: () => {
        let calls = 0
        const value = { toJSON: () => { calls += 1; return { encoded: true } } }
        return { state: { skillsById: { value } }, calls: () => calls }
      },
    },
    {
      label: 'accessor',
      create: () => {
        let calls = 0
        const skillsById: Record<string, unknown> = {}
        Object.defineProperty(skillsById, 'value', {
          configurable: true,
          enumerable: true,
          get: () => { calls += 1; return { accessed: true } },
        })
        return { state: { skillsById }, calls: () => calls }
      },
    },
    {
      label: 'sparse array',
      create: () => {
        const value: unknown[] = []
        value.length = 2
        value[1] = 'present'
        return { state: { skillsById: { value } } }
      },
    },
  ]

  it.each(fallbackCases)('falls back for $label without changing JSON semantics', ({ create }) => {
    const baseline = create()
    const expected = JSON.stringify(baseline.state)
    const optimized = create()
    const cloned = cloneBattleStateJson(optimized.state)

    expect(JSON.stringify(cloned)).toBe(expected)
    if (optimized.calls) expect(optimized.calls()).toBe(1)
  })

  it('falls back once for values outside the pure JSON subset', () => {
    let toJsonCalls = 0
    let accessorCalls = 0
    const createState = () => {
      const sparse: unknown[] = []
      sparse.length = 2
      sparse[1] = 'present'
      const custom = {
        toJSON: () => {
          toJsonCalls += 1
          return { encoded: true }
        },
      }
      const skillsById: Record<string, unknown> = {
        undefinedValue: undefined,
        functionValue: () => 1,
        dateValue: new Date('2024-01-02T03:04:05.000Z'),
        nanValue: Number.NaN,
        custom,
        sparse,
      }
      Object.defineProperty(skillsById, 'accessorValue', {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorCalls += 1
          return { accessed: true }
        },
      })
      return { skillsById }
    }

    const baseline = createState()
    const expected = JSON.stringify(baseline)
    toJsonCalls = 0
    accessorCalls = 0
    const cloned = cloneBattleStateJson(createState())

    expect(JSON.stringify(cloned)).toBe(expected)
    expect(toJsonCalls).toBe(1)
    expect(accessorCalls).toBe(1)
  })

  it('does not pollute prototypes while copying __proto__ keys', () => {
    const nested = Object.create(null) as Record<string, unknown>
    Object.defineProperty(nested, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
      writable: true,
    })
    const skillsById = Object.create(null) as Record<string, unknown>
    Object.defineProperty(skillsById, '__proto__', {
      configurable: true,
      enumerable: true,
      value: nested,
      writable: true,
    })
    const state = Object.create(null) as Record<string, unknown>
    Object.defineProperty(state, 'skillsById', {
      configurable: true,
      enumerable: true,
      value: skillsById,
      writable: true,
    })

    const cloned = cloneBattleStateJson(state) as typeof state & { skillsById: Record<string, unknown> }
    const clonedNested = cloned.skillsById.__proto__ as Record<string, unknown>
    const clonedPayload = clonedNested.__proto__ as Record<string, unknown>

    expect(Object.prototype.hasOwnProperty.call(cloned.skillsById, '__proto__')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(clonedNested, '__proto__')).toBe(true)
    expect(clonedPayload.polluted).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('leaves cyclic graphs to JSON.stringify so they still throw', () => {
    const skill: Record<string, unknown> = {}
    skill.self = skill
    const state = { skillsById: { skill } }

    expect(() => cloneBattleStateJson(state)).toThrow()
  })
})
