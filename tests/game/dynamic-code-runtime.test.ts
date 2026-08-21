import { describe, expect, it } from 'vitest'

import { DynamicCodeRuntime, DynamicCodeRuntimeError } from '@/lib/game/dynamic-code-runtime'

const request = (overrides: Partial<{ code: string; contentVersion: string }> = {}) => ({
  surface: 'skillCode' as const,
  contentId: 'runtime-fixture',
  contentVersion: '1',
  code: '(function(value) { return value + 1 })',
  entry: 'fixture entry',
  ...overrides,
})

describe('dynamic code runtime', () => {
  it('compiles an unchanged surface/version/hash only once', () => {
    const runtime = new DynamicCodeRuntime()
    const first = runtime.compileExpression<(value: number) => number>(request())
    const second = runtime.compileExpression<(value: number) => number>(request())

    expect(first).toBe(second)
    expect(first(2)).toBe(3)
    expect(runtime.stats()).toMatchObject({ compiled: 1, cached: 1 })
  })

  it('recompiles on code/version changes and only invalidates the requested content', () => {
    const runtime = new DynamicCodeRuntime()
    runtime.compileExpression(request())
    runtime.compileExpression(request({ code: '(function(value) { return value + 2 })' }))
    runtime.compileExpression(request({ contentVersion: '2' }))
    expect(runtime.stats().compiled).toBe(3)

    runtime.forceReload('skillCode', 'runtime-fixture')
    runtime.compileExpression(request())
    expect(runtime.stats().compiled).toBe(4)
  })

  it('reports surface, content ID, and version for invalid source or entry', () => {
    const runtime = new DynamicCodeRuntime()
    expect(() => runtime.compileExpression(request({ code: '(' }))).toThrow(DynamicCodeRuntimeError)
    expect(() => runtime.compileExpression(request({ code: '({})' }))).toThrow(/skillCode:runtime-fixture@1/)
  })
})
