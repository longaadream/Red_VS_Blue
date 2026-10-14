import { describe, expect, it } from 'vitest'
import {
  CONTENT_GRAPH_COMPILER_VERSION,
  CONTENT_GRAPH_VERSION,
  applyContentGraph,
  assertContentGraphArtifact,
  compileContentGraph,
  type ContentGraph,
  type ContentGraphRegion,
  type ContentGraphExpression,
  type ContentGraphSetTarget,
} from '@/lib/skill-graph/content-graph'

const literal = (value: string | number | boolean | null | undefined) => ({ kind: 'literal' as const, value })
const ref = (name: string) => ({ kind: 'ref' as const, name })
const get = (object: ReturnType<typeof ref>, key: string) => ({ kind: 'get' as const, object, key })
const undefinedExpression = () => ({ kind: 'undefined' as const })

function graph(surface: ContentGraph['surface'], nodes: ContentGraph['nodes'], entry = nodes[0].id): ContentGraph {
  return { version: CONTENT_GRAPH_VERSION, surface, entry, nodes }
}

describe('versioned content graph compiler', () => {
  it('compiles a skill graph to the existing executeSkill surface without graph trace data', () => {
    const contentGraph = graph('skill', [
      { id: 'start', kind: 'bind', name: 'source', expr: ref('context.piece'), next: 'select' },
      { id: 'select', kind: 'call', capability: 'selectTarget', args: [{ kind: 'object', entries: { type: literal('piece'), range: literal(2), filter: literal('enemy') } }], result: 'target', next: 'hit' },
      { id: 'hit', kind: 'call', capability: 'dealDamage', args: [ref('source'), ref('target'), literal(2), literal('true'), ref('context.battle'), ref('context.skill.id')], result: 'damage', next: 'done' },
      { id: 'done', kind: 'return', value: { kind: 'object', entries: { success: literal(true), message: get(ref('damage'), 'damage') } } },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.compilerVersion).toBe(CONTENT_GRAPH_COMPILER_VERSION)
    expect(compiled.code).toContain('function executeSkill(context)')
    expect(compiled.code).toContain('selectTarget({')
    expect(compiled.code).toContain('selectTarget({type: "piece"')
    expect(compiled.code).toContain('dealDamage(source, target, 2, "true", context.battle, context.skill.id)')
    expect(compiled.code).not.toContain('graphTrace')
    expect(compiled.code).not.toContain('eval(')

    const execute = new Function('selectTarget', 'dealDamage', `return (${compiled.code})`)(() => ({ instanceId: 'target' }), (_source: unknown, _target: unknown, amount: number) => ({ damage: amount })) as (context: unknown) => unknown
    const result = execute({ piece: { instanceId: 'caster' }, battle: {}, skill: { id: 'test' } })
    expect(result).toEqual({ success: true, message: 2 })
  })

  it('keeps rule healing in the existing heal queue and emits a rule body', () => {
    const contentGraph = graph('rule', [
      { id: 'start', kind: 'call', capability: 'queue.heal', args: [ref('context.rulePiece'), ref('context.rulePiece'), literal(1), literal('regen')], next: 'done' },
      { id: 'done', kind: 'return', value: { kind: 'object', entries: { success: literal(true), message: literal('触发超速再生') } } },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.code).not.toContain('function execute')
    expect(compiled.code).toContain('context.healQueue.push({ healer: context.rulePiece')
    const context: { rulePiece: { instanceId: string }; healQueue: unknown[] } = { rulePiece: { instanceId: 'piece' }, healQueue: [] }
    const execute = new Function('context', compiled.code) as (value: typeof context) => unknown
    expect(execute(context)).toEqual({ success: true, message: '触发超速再生' })
    expect(context.healQueue).toEqual([{ healer: context.rulePiece, target: context.rulePiece, heal: 1, skillId: 'regen' }])
  })

  it('supports preview and pending entry signatures with allowlisted pure expressions', () => {
    const preview = compileContentGraph(graph('preview', [
      { id: 'start', kind: 'return', value: { kind: 'object', entries: { expectedValues: { kind: 'object', entries: { damage: { kind: 'call', callee: 'Math.floor', args: [{ kind: 'binary', op: '*', left: get(ref('piece'), 'attack'), right: literal(1.5) }] } } } } } },
    ]))
    expect(preview.code).toContain('function calculatePreview(piece, skillDef, currentCooldown)')
    const calculate = new Function(`return (${preview.code})`)() as (piece: { attack: number }) => unknown
    expect(calculate({ attack: 3 })).toEqual({ expectedValues: { damage: 4 } })

    const pending = compileContentGraph(graph('pending', [
      { id: 'start', kind: 'return', value: get(ref('ctx'), 'payload') },
    ]))
    expect(pending.code).toContain('function(ctx)')
    expect(new Function(`return (${pending.code})`)()({ payload: 'ok' })).toBe('ok')
  })

  it('allows injected pure team queries with their fixed signatures', () => {
    const compiled = compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'object', entries: {
        allied: { kind: 'call', callee: 'arePlayersAllied', args: [get(ref('context'), 'battle'), get(ref('context'), 'left'), get(ref('context'), 'right')] },
        next: { kind: 'call', callee: 'nextEnemyPlayer', args: [get(ref('context'), 'battle'), get(ref('context'), 'left')] },
        finite: { kind: 'call', callee: 'Number.isFinite', args: [get(ref('context'), 'value')] },
      } },
    }]))
    expect(compiled.code).toContain('arePlayersAllied((context)["battle"], (context)["left"], (context)["right"])')
    expect(compiled.code).toContain('nextEnemyPlayer((context)["battle"], (context)["left"])')
    expect(compiled.code).toContain('Number.isFinite((context)["value"])')
    const execute = new Function('arePlayersAllied', 'nextEnemyPlayer', `return (${compiled.code})`)(() => true, () => 'b') as (context: unknown) => unknown
    expect(execute({ battle: {}, left: 'a', right: 'b', value: 1 })).toEqual({ allied: true, next: 'b', finite: true })
    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'call', callee: 'nextEnemyPlayer', args: [get(ref('context'), 'battle')] },
    }]))).toThrow('参数数量')
  })

  it('types only surface-allowed direct capability helpers without invoking them', () => {
    const compiled = compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'object', entries: {
        addRule: { kind: 'capabilityType', capability: 'addRuleById' },
        addStatus: { kind: 'capabilityType', capability: 'addStatusEffectById' },
        getHand: { kind: 'capabilityType', capability: 'getHand' },
        removeStatus: { kind: 'capabilityType', capability: 'removeStatusEffectById' },
      } },
    }]))
    expect(compiled.code).toContain('typeof addRuleById')
    expect(compiled.code).toContain('typeof addStatusEffectById')
    expect(compiled.code).toContain('typeof getHand')
    expect(compiled.code).toContain('typeof removeStatusEffectById')
    const execute = new Function('addRuleById', 'addStatusEffectById', 'getHand', 'removeStatusEffectById', `return (${compiled.code})`)(
      () => { throw new Error('called') }, () => { throw new Error('called') }, () => { throw new Error('called') }, () => { throw new Error('called') },
    ) as (context: unknown) => unknown
    expect(execute({ battle: {} })).toEqual({
      addRule: 'function',
      addStatus: 'function',
      getHand: 'function',
      removeStatus: 'function',
    })

    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'capabilityType', capability: 'flow.effects.move' },
    }]))).toThrow('单标识符')
    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'capabilityType', capability: 'array.push' },
    }]))).toThrow('单标识符')
    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'capabilityType', capability: 'unknownHelper' },
    }]))).toThrow('不允许使用 helper')
    expect(() => compileContentGraph(graph('preview', [{
      id: 'return', kind: 'return', value: { kind: 'capabilityType', capability: 'addRuleById' },
    }]))).toThrow('不允许使用 helper')
  })

  it('preserves native string collection and template interpolation semantics', () => {
    const contentGraph = graph('skill', [
      { id: 'source', kind: 'bind', name: 'source', expr: literal('MiXeD'), next: 'lower' },
      { id: 'lower', kind: 'bind', name: 'lower', expr: { kind: 'collection', object: ref('source'), method: 'toLowerCase', args: [] }, next: 'upper' },
      { id: 'upper', kind: 'bind', name: 'upper', expr: { kind: 'collection', object: ref('source'), method: 'toUpperCase', args: [] }, next: 'split' },
      { id: 'split', kind: 'bind', name: 'parts', expr: { kind: 'collection', object: ref('source'), method: 'split', args: [literal('X')] }, next: 'return' },
      {
        id: 'return', kind: 'return', value: { kind: 'object', entries: {
          lower: ref('lower'),
          upper: ref('upper'),
          parts: ref('parts'),
          template: { kind: 'template', head: 'hello `', spans: [ref('lower')], tails: ['', ' / ${literal} \\ \nend'] },
        } },
      },
    ])
    const compiled = compileContentGraph(contentGraph)
    const execute = new Function(`return (${compiled.code})`)() as (context: unknown) => unknown
    expect(execute({ battle: {} })).toEqual({
      lower: 'mixed',
      upper: 'MIXED',
      parts: ['Mi', 'eD'],
      template: 'hello `mixed / ${literal} \\ \nend',
    })
    const nativeStringMethods = graph('skill', [
      { id: 'source', kind: 'bind', name: 'source', expr: literal('  Alpha  '), next: 'trim' },
      { id: 'trim', kind: 'bind', name: 'trimmed', expr: { kind: 'collection', object: ref('source'), method: 'trim', args: [] }, next: 'starts' },
      { id: 'starts', kind: 'bind', name: 'starts', expr: { kind: 'collection', object: ref('trimmed'), method: 'startsWith', args: [literal('Al'), literal(0)] }, next: 'compare' },
      { id: 'compare', kind: 'bind', name: 'compare', expr: { kind: 'collection', object: ref('trimmed'), method: 'localeCompare', args: [literal('Alpha')] }, next: 'done' },
      { id: 'done', kind: 'return', value: { kind: 'object', entries: { trimmed: ref('trimmed'), starts: ref('starts'), compare: ref('compare') } } },
    ])
    const nativeStringExecute = new Function(`return (${compileContentGraph(nativeStringMethods).code})`)() as (context: unknown) => unknown
    expect(nativeStringExecute({ battle: {} })).toEqual({ trimmed: 'Alpha', starts: true, compare: 0 })
    expect(() => compileContentGraph(graph('skill', [
      { id: 'value', kind: 'bind', name: 'value', expr: { kind: 'array', items: [] }, next: 'lower' },
      { id: 'lower', kind: 'bind', name: 'lower', expr: { kind: 'collection', object: ref('value'), method: 'toLowerCase', args: [] }, next: 'done' },
      { id: 'done', kind: 'return' },
    ]))).toThrow('仅支持字符串')
    expect(() => compileContentGraph(graph('skill', [
      { id: 'value', kind: 'bind', name: 'value', expr: { kind: 'array', items: [] }, next: 'starts' },
      { id: 'starts', kind: 'bind', name: 'starts', expr: { kind: 'collection', object: ref('value'), method: 'startsWith', args: [literal('a')] }, next: 'done' },
      { id: 'done', kind: 'return' },
    ]))).toThrow('仅支持字符串')
    expect(() => compileContentGraph(graph('skill', [
      { id: 'return', kind: 'return', value: { kind: 'template', head: 'bad', spans: [], tails: [] } },
    ]))).toThrow('spans.length + 1')
  })

  it('captures bound methods once and preserves their receiver', () => {
    const contentGraph = graph('skill', [
      { id: 'bound', kind: 'bind', name: 'bound', expr: { kind: 'boundMethod', object: get(ref('context'), 'receiver'), method: 'push' }, next: 'invoke' },
      { id: 'invoke', kind: 'invoke', target: { kind: 'function', value: ref('bound') }, args: [literal(4)], result: 'result', next: 'done' },
      { id: 'done', kind: 'return', value: ref('result') },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.code).toContain('Reflect.apply(capturedMethod, receiver, arguments)')
    const order: string[] = []
    const receiver = {
      value: 5,
      get push() {
        order.push('push')
        return function (this: { value: number }, amount: number) {
          order.push(this === receiver ? 'this' : 'wrong-this')
          return this.value + amount
        }
      },
    }
    const context = {
      get receiver() {
        order.push('receiver')
        return receiver
      },
    }
    const execute = new Function(`return (${compiled.code})`)() as (value: { receiver: unknown }) => unknown
    expect(execute(context)).toBe(9)
    expect(order).toEqual(['receiver', 'push', 'this'])
    expect(() => execute({ receiver: null })).toThrow(TypeError)

    const arrayGraph = graph('skill', [
      { id: 'bound', kind: 'bind', name: 'bound', expr: { kind: 'boundMethod', object: get(ref('context'), 'items'), method: 'push' }, next: 'invoke' },
      { id: 'invoke', kind: 'invoke', target: { kind: 'function', value: ref('bound') }, args: [literal(3)], result: 'length', next: 'done' },
      { id: 'done', kind: 'return', value: ref('length') },
    ])
    const items = [1, 2]
    const pushExecute = new Function(`return (${compileContentGraph(arrayGraph).code})`)() as (value: { items: number[] }) => unknown
    expect(pushExecute({ items })).toBe(3)
    expect(items).toEqual([1, 2, 3])

    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'boundMethod', object: literal('x'), method: 'push' },
    }]))).toThrow('仅支持数组 receiver')
    const nullReceiver = compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'boundMethod', object: undefinedExpression(), method: 'push' },
    }]))
    expect(() => new Function('return (' + nullReceiver.code + ')')()({})).toThrow(TypeError)
    expect(() => compileContentGraph(graph('skill', [{
      id: 'reflect', kind: 'bind', name: 'Reflect', expr: literal(1), next: 'done' }, { id: 'done', kind: 'return' }]))).toThrow('bind.name 无效')
    expect(() => compileContentGraph(graph('skill', [{
      id: 'function', kind: 'return', value: {
        kind: 'function', parameters: ['Reflect'], body: {
          entry: 'return', end: 'end', nodes: [
            { id: 'return', kind: 'return', value: ref('Reflect') },
            { id: 'end', kind: 'regionEnd' },
          ],
        },
      },
    }]))).toThrow('function 参数名无效')
  })

  it('materializes isolated card source graphs from strict JSON binding snapshots', () => {
    const child = graph('card', [
      { id: 'return', kind: 'return', value: ref('items') },
    ])
    const parent = graph('skill', [
      {
        id: 'source',
        kind: 'materializeSource',
        graph: child,
        bindings: { items: get(ref('context'), 'items') },
        result: 'source',
        next: 'done',
      },
      { id: 'done', kind: 'return', value: ref('source') },
    ])
    const compiled = compileContentGraph(parent)
    expect(compiled.code).toContain('function executeCard(context)')
    expect(compiled.code).toContain('globalThis.JSON.parse')
    const items = [1, 2]
    const execute = new Function('return (' + compiled.code + ')')() as (context: { items: unknown }) => string
    const source = execute({ items })
    items.push(3)
    const executeCard = new Function('return (' + source + ')')() as (context: unknown) => unknown
    expect(executeCard({})).toEqual([1, 2])
    const unicodeSource = execute({ items: ['line\u2028separator'] })
    expect(new Function('return (' + unicodeSource + ')')()({})).toEqual(['line\u2028separator'])

    const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const dangerousSource = execute({ items: dangerous })
    const dangerousValue = new Function('return (' + dangerousSource + ')')()({}) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(dangerousValue, '__proto__')).toBe(true)
    expect(dangerousValue.__proto__).toEqual({ polluted: true })
    expect(Object.getPrototypeOf(dangerousValue)).toBe(Object.prototype)

    const markerChild = graph('card', [{
      id: 'return', kind: 'return', value: { kind: 'object', entries: { a: ref('a'), b: ref('b') } },
    }])
    const markerParent = graph('skill', [
      {
        id: 'source', kind: 'materializeSource', graph: markerChild,
        bindings: { a: literal('var b = __rvb_content_graph_binding_1__;'), b: literal(2) },
        result: 'source', next: 'done',
      },
      { id: 'done', kind: 'return', value: ref('source') },
    ])
    const markerSource = new Function('return (' + compileContentGraph(markerParent).code + ')')()({}) as string
    expect(new Function('return (' + markerSource + ')')()({})).toEqual({
      a: 'var b = __rvb_content_graph_binding_1__;', b: 2,
    })

    let nestedGetterCalls = 0
    const unsafe = {
      get hidden() {
        nestedGetterCalls += 1
        return 1
      },
    }
    const unsafeContext = { value: unsafe }
    const unsafeGraph = graph('skill', [
      { id: 'source', kind: 'materializeSource', graph: child, bindings: { items: get(ref('context'), 'value') }, result: 'source', next: 'done' },
      { id: 'done', kind: 'return', value: ref('source') },
    ])
    expect(() => {
      const unsafeExecute = new Function('return (' + compileContentGraph(unsafeGraph).code + ')')() as (context: typeof unsafeContext) => unknown
      unsafeExecute(unsafeContext)
    }).toThrow('getters')
    expect(nestedGetterCalls).toBe(0)

    let toJsonCalls = 0
    const toJson = { toJSON: () => { toJsonCalls += 1; return {} } }
    const toJsonGraph = graph('skill', [
      { id: 'source', kind: 'materializeSource', graph: child, bindings: { items: get(ref('context'), 'value') }, result: 'source', next: 'done' },
      { id: 'done', kind: 'return', value: ref('source') },
    ])
    const toJsonExecute = new Function('return (' + compileContentGraph(toJsonGraph).code + ')')() as (context: { value: typeof toJson }) => unknown
    expect(() => toJsonExecute({ value: toJson })).toThrow('toJSON')
    expect(toJsonCalls).toBe(0)

    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const invalidValues: unknown[] = [() => 1, Number.NaN, cycle, undefined]
    const invalidExecute = new Function('return (' + compileContentGraph(toJsonGraph).code + ')')() as (context: { value: unknown }) => unknown
    for (const value of invalidValues) expect(() => invalidExecute({ value })).toThrow('content graph binding')

    const pendingChild = graph('pending', [
      { id: 'return', kind: 'return', value: ref('payload') },
    ])
    const pendingParent = graph('skill', [
      { id: 'source', kind: 'materializeSource', graph: pendingChild, bindings: { payload: literal('pending') }, result: 'source', next: 'done' },
      { id: 'done', kind: 'return', value: ref('source') },
    ])
    const pendingSource = new Function('return (' + compileContentGraph(pendingParent).code + ')')()({})
    expect(pendingSource).toContain('function(ctx)')
    expect(new Function('return (' + pendingSource + ')')()({})).toBe('pending')

    const fixedChild = graph('card', [
      { id: 'return', kind: 'return', value: literal('fixed') },
    ])
    const fixedSource = graph('skill', [
      { id: 'return', kind: 'return', value: { kind: 'source', graph: fixedChild } },
    ])
    expect(new Function('return (' + compileContentGraph(fixedSource).code + ')')()({})).toContain('function executeCard(context)')
    expect(() => compileContentGraph(graph('skill', [
      { id: 'source', kind: 'materializeSource', graph: graph('skill', [{ id: 'return', kind: 'return', value: literal('bad') }]), bindings: {}, result: 'source', next: 'done' },
      { id: 'done', kind: 'return', value: ref('source') },
    ]))).toThrow('只支持 card 或 pending')
    expect(() => compileContentGraph(graph('skill', [
      { id: 'source', kind: 'materializeSource', graph: graph('card', [{ id: 'return', kind: 'return', value: ref('secret') }]), bindings: {}, result: 'source', next: 'done' },
      { id: 'done', kind: 'return', value: ref('source') },
    ]))).toThrow('不提供输入引用')
  })

  it('keeps pure collection reduce typed and native, including empty-array throw semantics', () => {
    const reduced = compileContentGraph(graph('skill', [
      {
        id: 'return',
        kind: 'return',
        value: {
          kind: 'collection',
          object: { kind: 'array', items: [literal(1), literal(2), literal(3)] },
          method: 'reduce',
          args: [{
            kind: 'lambda',
            parameters: ['total', 'value', 'index', 'array'],
            body: { kind: 'binary', op: '+', left: ref('total'), right: ref('value') },
          }, literal(0)],
        },
      },
    ]))
    expect(reduced.code).toContain('[\"reduce\"](function (total, value, index, array)')
    expect(new Function('return (' + reduced.code + ')')()({})).toBe(6)

    const empty = compileContentGraph(graph('skill', [
      {
        id: 'return',
        kind: 'return',
        value: {
          kind: 'collection',
          object: { kind: 'array', items: [] },
          method: 'reduce',
          args: [{ kind: 'lambda', parameters: ['value'], body: ref('value') }],
        },
      },
    ]))
    const executeEmpty = new Function('return (' + empty.code + ')')() as (context: unknown) => unknown
    expect(() => executeEmpty({})).toThrow(TypeError)
  })

  it('keeps structured try/catch/finally completion and throw behavior', () => {
    const body: ContentGraphRegion = {
      entry: 'try-log', end: 'try-end', nodes: [
        { id: 'try-log', kind: 'call', capability: 'array.push', args: [ref('events'), literal('try')], next: 'try-throw' },
        { id: 'try-throw', kind: 'throw', value: { kind: 'object', entries: { message: literal('boom') } } },
        { id: 'try-end', kind: 'regionEnd' },
      ],
    }
    const catchBody: ContentGraphRegion = {
      entry: 'catch-log', end: 'catch-end', nodes: [
        { id: 'catch-log', kind: 'call', capability: 'array.push', args: [ref('events'), get(ref('error'), 'message')], next: 'catch-end' },
        { id: 'catch-end', kind: 'regionEnd' },
      ],
    }
    const finallyBody: ContentGraphRegion = {
      entry: 'finally-log', end: 'finally-end', nodes: [
        { id: 'finally-log', kind: 'call', capability: 'array.push', args: [ref('events'), literal('finally')], next: 'finally-end' },
        { id: 'finally-end', kind: 'regionEnd' },
      ],
    }
    const contentGraph = graph('skill', [
      { id: 'events', kind: 'bind', name: 'events', expr: get(ref('context'), 'events'), next: 'try' },
      { id: 'try', kind: 'try', body, catch: { parameter: 'error', body: catchBody }, finally: finallyBody, next: 'done' },
      { id: 'done', kind: 'return', value: ref('events') },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.code).toContain('catch (error)')
    expect(compiled.code).toContain('finally')
    const execute = new Function(`return (${compiled.code})`)() as (context: { events: unknown[] }) => unknown
    const events: unknown[] = []
    expect(execute({ events })).toBe(events)
    expect(events).toEqual(['try', 'boom', 'finally'])

    const returnFinally = graph('skill', [
      { id: 'events', kind: 'bind', name: 'events', expr: get(ref('context'), 'events'), next: 'try' },
      {
        id: 'try', kind: 'try', body: {
          entry: 'return', end: 'body-end', nodes: [
            { id: 'return', kind: 'return', value: literal('done') },
            { id: 'body-end', kind: 'regionEnd' },
          ],
        }, finally: finallyBody, next: 'unreachable',
      },
      { id: 'unreachable', kind: 'return', value: literal('wrong') },
    ])
    const returnExecute = new Function(`return (${compileContentGraph(returnFinally).code})`)() as (context: { events: unknown[] }) => unknown
    const returnEvents: unknown[] = []
    expect(returnExecute({ events: returnEvents })).toBe('done')
    expect(returnEvents).toEqual(['finally'])

    const uncaught = graph('skill', [
      { id: 'events', kind: 'bind', name: 'events', expr: get(ref('context'), 'events'), next: 'try' },
      {
        id: 'try', kind: 'try', body: {
          entry: 'throw', end: 'body-end', nodes: [
            { id: 'throw', kind: 'throw', value: literal('uncaught') },
            { id: 'body-end', kind: 'regionEnd' },
          ],
        }, finally: finallyBody, next: 'done',
      },
      { id: 'done', kind: 'return' },
    ])
    const uncaughtExecute = new Function(`return (${compileContentGraph(uncaught).code})`)() as (context: { events: unknown[] }) => unknown
    const uncaughtEvents: unknown[] = []
    expect(() => uncaughtExecute({ events: uncaughtEvents })).toThrow('uncaught')
    expect(uncaughtEvents).toEqual(['finally'])

    const breakBody: ContentGraphRegion = {
      entry: 'break-try', end: 'break-body-end', nodes: [
        {
          id: 'break-try', kind: 'try', body: {
            entry: 'break', end: 'break-try-end', nodes: [
              { id: 'break', kind: 'break' },
              { id: 'break-try-end', kind: 'regionEnd' },
            ],
          }, finally: {
            entry: 'break-finally-log', end: 'break-finally-end', nodes: [
              { id: 'break-finally-log', kind: 'call', capability: 'array.push', args: [ref('events'), literal('break-finally')], next: 'break-finally-end' },
              { id: 'break-finally-end', kind: 'regionEnd' },
            ],
          }, next: 'break-body-end',
        },
        { id: 'break-body-end', kind: 'regionEnd' },
      ],
    }
    const breakGraph = graph('skill', [
      { id: 'events', kind: 'bind', name: 'events', expr: get(ref('context'), 'events'), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'while', condition: literal(true), body: breakBody, next: 'done' },
      { id: 'done', kind: 'return', value: ref('events') },
    ])
    const breakExecute = new Function(`return (${compileContentGraph(breakGraph).code})`)() as (context: { events: unknown[] }) => unknown
    const breakEvents: unknown[] = []
    expect(breakExecute({ events: breakEvents })).toBe(breakEvents)
    expect(breakEvents).toEqual(['break-finally'])

    const continueBody: ContentGraphRegion = {
      entry: 'continue-try', end: 'continue-body-end', nodes: [
        {
          id: 'continue-try', kind: 'try', body: {
            entry: 'continue', end: 'continue-try-end', nodes: [
              { id: 'continue', kind: 'continue' },
              { id: 'continue-try-end', kind: 'regionEnd' },
            ],
          }, finally: {
            entry: 'continue-finally-log', end: 'continue-finally-end', nodes: [
              { id: 'continue-finally-log', kind: 'call', capability: 'array.push', args: [ref('events'), literal('continue-finally')], next: 'continue-finally-end' },
              { id: 'continue-finally-end', kind: 'regionEnd' },
            ],
          }, next: 'continue-body-end',
        },
        { id: 'continue-body-end', kind: 'regionEnd' },
      ],
    }
    const continueGraph = graph('skill', [
      { id: 'events', kind: 'bind', name: 'events', expr: get(ref('context'), 'events'), next: 'index' },
      { id: 'index', kind: 'bind', name: 'index', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'for', condition: { kind: 'binary', op: '<', left: ref('index'), right: literal(2) }, body: continueBody, update: {
        entry: 'increment', end: 'increment-end', nodes: [
          { id: 'increment', kind: 'set', target: { kind: 'ref', name: 'index' }, operator: '+=', value: literal(1), next: 'increment-end' },
          { id: 'increment-end', kind: 'regionEnd' },
        ],
      }, next: 'done' },
      { id: 'done', kind: 'return', value: ref('events') },
    ])
    const continueExecute = new Function(`return (${compileContentGraph(continueGraph).code})`)() as (context: { events: unknown[] }) => unknown
    const continueEvents: unknown[] = []
    expect(continueExecute({ events: continueEvents })).toBe(continueEvents)
    expect(continueEvents).toEqual(['continue-finally', 'continue-finally'])

    expect(() => compileContentGraph(graph('skill', [{ id: 'try', kind: 'try', body, next: 'done' }, { id: 'done', kind: 'return' }]))).toThrow('至少需要 catch 或 finally')
  })

  it('keeps editor layout coordinates out of semantics and accepts converging branch edges', () => {
    const compiled = compileContentGraph(graph('skill', [
      { id: 'start', kind: 'branch', condition: literal(false), yes: 'done', no: 'done', x: 20, y: 40 },
      { id: 'done', kind: 'return', value: literal('same'), x: 320, y: 40 },
    ]))
    expect(compiled.code).not.toContain('x: 20')
    expect(compiled.code).not.toContain('y: 40')
    const execute = new Function(`return (${compiled.code})`)() as () => unknown
    expect(execute()).toBe('same')
  })

  it('supports typed index, pure collection lambdas, undefined and ordered assignments', () => {
    const contentGraph = graph('skill', [
      { id: 'value', kind: 'bind', name: 'value', expr: literal(10), next: 'items' },
      { id: 'items', kind: 'bind', name: 'items', expr: { kind: 'array', items: [literal(1), literal(2)] }, next: 'mapped' },
      {
        id: 'mapped', kind: 'bind', name: 'mapped', next: 'write',
        expr: {
          kind: 'collection', object: ref('items'), method: 'map', args: [{
            kind: 'lambda', parameters: ['value'],
            body: { kind: 'binary', op: '+', left: ref('value'), right: literal(1) },
          }],
        },
      },
      {
        id: 'write', kind: 'set', operator: '=', next: 'done',
        target: { kind: 'index', object: get(ref('context'), 'values'), index: literal(0) },
        value: get(ref('context'), 'rhs'),
      },
      {
        id: 'done', kind: 'return', value: { kind: 'object', entries: {
          mapped: ref('mapped'),
          value: { kind: 'index', object: get(ref('context'), 'values'), index: literal(0) },
          missing: undefinedExpression(),
        } },
      },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.code).toContain('["map"](function (value)')
    expect(compiled.code).toContain('(void 0)')
    expect(compiled.code).toContain('((context)["values"])[0]')
    const order: string[] = []
    const values = [0]
    const context = {
      get values() { order.push('target'); return values },
      get rhs() { order.push('value'); return 7 },
    }
    const execute = new Function(`return (${compiled.code})`)() as (value: typeof context) => unknown
    expect(execute(context)).toEqual({ mapped: [2, 3], value: 7, missing: undefined })
    expect(order.slice(0, 2)).toEqual(['target', 'value'])

    const compound = compileContentGraph(graph('skill', [
      { id: 'bind', kind: 'bind', name: 'count', expr: literal(1), next: 'add' },
      { id: 'add', kind: 'set', target: { kind: 'ref', name: 'count' }, operator: '+=', value: literal(2), next: 'return' },
      { id: 'return', kind: 'return', value: ref('count') },
    ]))
    expect(new Function(`return (${compound.code})`)()({})).toBe(3)
    expect(() => compileContentGraph(graph('skill', [
      { id: 'undefined', kind: 'bind', name: 'undefined', expr: literal(1), next: 'done' },
      { id: 'done', kind: 'return', value: undefinedExpression() },
    ]))).toThrow('bind.name 无效')
  })

  it('executes graph functions as ordered callbacks with live closure captures', () => {
    const callbackBody = {
      entry: 'callback-add',
      end: 'callback-end',
      nodes: [
        { id: 'callback-add', kind: 'set' as const, target: { kind: 'ref' as const, name: 'total' }, operator: '+=' as const, value: ref('amount'), next: 'callback-end' },
        { id: 'callback-end', kind: 'regionEnd' as const },
      ],
    }
    const callbackGraph = graph('skill', [
      { id: 'total', kind: 'bind', name: 'total', expr: literal(0), next: 'for-each' },
      {
        id: 'for-each', kind: 'invoke', target: { kind: 'array', object: get(ref('context'), 'items'), method: 'forEach' },
        args: [{ kind: 'function', parameters: ['amount'], body: callbackBody }], next: 'done',
      },
      { id: 'done', kind: 'return', value: ref('total') },
    ])
    const compiled = compileContentGraph(callbackGraph)
    expect(compiled.code).toContain('["forEach"](function (amount)')
    const execute = new Function(`return (${compiled.code})`)() as (context: { items: number[] }) => unknown
    expect(execute({ items: [1, 2, 3] })).toBe(6)
  })

  it('keeps function parameters local and returns graph results to invoke callers', () => {
    const helperBody = {
      entry: 'helper-return',
      end: 'helper-end',
      nodes: [
        { id: 'helper-return', kind: 'return' as const, value: ref('offset') },
        { id: 'helper-end', kind: 'regionEnd' as const },
      ],
    }
    const helperGraph = graph('skill', [
      { id: 'outer-offset', kind: 'bind', name: 'offset', expr: literal(10), next: 'helper' },
      { id: 'helper', kind: 'bind', name: 'helper', expr: { kind: 'function', parameters: ['offset'], body: helperBody }, next: 'invoke' },
      { id: 'invoke', kind: 'invoke', target: { kind: 'function', value: ref('helper') }, args: [literal(3)], result: 'result', next: 'done' },
      { id: 'done', kind: 'return', value: ref('result') },
    ])
    const compiled = compileContentGraph(helperGraph)
    const execute = new Function(`return (${compiled.code})`)() as () => unknown
    expect(execute()).toBe(3)
  })

  it('rejects callbacks that capture a non-dominating branch local', () => {
    const body = {
      entry: 'callback-return',
      end: 'callback-end',
      nodes: [
        { id: 'callback-return', kind: 'return' as const, value: ref('branchOnly') },
        { id: 'callback-end', kind: 'regionEnd' as const },
      ],
    }
    const graphWithInvalidCapture = graph('skill', [
      { id: 'start', kind: 'branch', condition: literal(true), yes: 'declared', no: 'invoke' },
      { id: 'declared', kind: 'bind', name: 'branchOnly', expr: literal(1), next: 'invoke' },
      { id: 'invoke', kind: 'invoke', target: { kind: 'array', object: get(ref('context'), 'items'), method: 'forEach' }, args: [{ kind: 'function', parameters: [], body }], next: 'done' },
      { id: 'done', kind: 'return' },
    ])
    expect(() => compileContentGraph(graphWithInvalidCapture)).toThrow('引用')
  })

  it('preserves free captures when function-region names resemble generated names', () => {
    const captureName = '__rvb_content_graph_region_pc_0'
    const functionBody = {
      entry: 'function-bind', end: 'function-end', nodes: [
        { id: 'function-bind', kind: 'bind' as const, name: 'localValue', expr: literal(1), next: 'function-return' },
        { id: 'function-return', kind: 'return' as const, value: ref(captureName) },
        { id: 'function-end', kind: 'regionEnd' as const },
      ],
    }
    const captureGraph = graph('skill', [
      { id: 'capture', kind: 'bind', name: captureName, expr: literal(7), next: 'function' },
      { id: 'function', kind: 'bind', name: 'callback', expr: { kind: 'function', parameters: [], body: functionBody }, next: 'invoke' },
      { id: 'invoke', kind: 'invoke', target: { kind: 'function', value: ref('callback') }, args: [], result: 'result', next: 'done' },
      { id: 'done', kind: 'return', value: ref('result') },
    ])
    const compiled = compileContentGraph(captureGraph)
    const execute = new Function(`return (${compiled.code})`)() as () => unknown
    expect(execute()).toBe(7)
  })

  it('supports structured delete and preserves its boolean result', () => {
    const contentGraph = graph('skill', [
      { id: 'box', kind: 'bind', name: 'box', expr: get(ref('context'), 'box'), next: 'delete' },
      { id: 'delete', kind: 'delete', target: { kind: 'get', object: ref('box'), key: 'value' }, result: 'deleted', next: 'done' },
      { id: 'done', kind: 'return', value: { kind: 'object', entries: { deleted: ref('deleted'), value: get(ref('box'), 'value') } } },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.code).toContain('delete (box)["value"]')
    const execute = new Function(`return (${compiled.code})`)() as (context: { box: Record<string, unknown> }) => unknown
    const box = { value: 3 }
    expect(execute({ box })).toEqual({ deleted: true, value: undefined })
    expect(box).toEqual({})
    expect(() => compileContentGraph(graph('skill', [
      { id: 'delete', kind: 'delete', target: { kind: 'ref', name: 'box' } as never, next: 'done' },
      { id: 'done', kind: 'return' },
    ]))).toThrow('get 或 index')
  })

  it('uses native reduce semantics, including empty arrays without an initial value', () => {
    const reducer: ContentGraphExpression = { kind: 'function', parameters: ['sum', 'value'], body: {
      entry: 'reduce-return', end: 'reduce-end', nodes: [
        { id: 'reduce-return', kind: 'return' as const, value: { kind: 'binary' as const, op: '+', left: ref('sum'), right: ref('value') } },
        { id: 'reduce-end', kind: 'regionEnd' as const },
      ],
    } }
    const withInitial = graph('skill', [
      { id: 'items', kind: 'bind', name: 'items', expr: get(ref('context'), 'items'), next: 'reduce' },
      { id: 'reduce', kind: 'invoke', target: { kind: 'array', object: ref('items'), method: 'reduce' }, args: [reducer, literal(0)], result: 'total', next: 'done' },
      { id: 'done', kind: 'return', value: ref('total') },
    ])
    const withInitialCode = compileContentGraph(withInitial).code
    expect(withInitialCode).toContain('["reduce"](function (sum, value)')
    const withInitialExecute = new Function(`return (${withInitialCode})`)() as (context: { items: number[] }) => unknown
    expect(withInitialExecute({ items: [1, 2, 3] })).toBe(6)

    const withoutInitial = graph('skill', [
      { id: 'items', kind: 'bind', name: 'items', expr: get(ref('context'), 'items'), next: 'reduce' },
      { id: 'reduce', kind: 'invoke', target: { kind: 'array', object: ref('items'), method: 'reduce' }, args: [reducer], result: 'total', next: 'done' },
      { id: 'done', kind: 'return', value: ref('total') },
    ])
    const executeWithoutInitial = new Function(`return (${compileContentGraph(withoutInitial).code})`)() as (context: { items: number[] }) => unknown
    expect(executeWithoutInitial({ items: [1, 2, 3] })).toBe(6)
    expect(() => executeWithoutInitial({ items: [] })).toThrow(TypeError)
  })

  it('keeps for-of iterator mutation semantics and supports loop control', () => {
    const body: ContentGraphRegion = {
      entry: 'check', end: 'body-end', nodes: [
        { id: 'check', kind: 'branch', condition: { kind: 'binary', op: '===', left: ref('item'), right: literal(1) }, yes: 'append', no: 'add' },
        { id: 'append', kind: 'call', capability: 'array.push', args: [ref('items'), literal(3)], next: 'add' },
        { id: 'add', kind: 'set', target: { kind: 'ref', name: 'total' }, operator: '+=', value: ref('item'), next: 'body-end' },
        { id: 'body-end', kind: 'regionEnd' },
      ],
    }
    const contentGraph = graph('skill', [
      { id: 'items', kind: 'bind', name: 'items', expr: get(ref('context'), 'items'), next: 'total' },
      { id: 'total', kind: 'bind', name: 'total', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'forOf', iterable: ref('items'), item: 'item', body, next: 'done' },
      { id: 'done', kind: 'return', value: ref('total') },
    ])
    const compiled = compileContentGraph(contentGraph)
    expect(compiled.code).toContain('for (item of items)')
    const execute = new Function(`return (${compiled.code})`)() as (context: { items: number[] }) => unknown
    expect(execute({ items: [1, 2] })).toBe(6)
  })

  it('executes structured for regions, including continue through update', () => {
    const body: ContentGraphRegion = {
      entry: 'body-add', end: 'body-end', nodes: [
        { id: 'body-add', kind: 'set', target: { kind: 'ref', name: 'sum' }, operator: '+=', value: ref('i'), next: 'body-end' },
        { id: 'body-end', kind: 'regionEnd' },
      ],
    }
    const update: ContentGraphRegion = {
      entry: 'update-i', end: 'update-end', nodes: [
        { id: 'update-i', kind: 'set', target: { kind: 'ref', name: 'i' }, operator: '+=', value: literal(1), next: 'update-end' },
        { id: 'update-end', kind: 'regionEnd' },
      ],
    }
    const sumGraph = graph('skill', [
      { id: 'init-i', kind: 'bind', name: 'i', expr: literal(0), next: 'init-sum' },
      { id: 'init-sum', kind: 'bind', name: 'sum', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'for', condition: { kind: 'binary', op: '<', left: ref('i'), right: literal(3) }, body, update, next: 'done' },
      { id: 'done', kind: 'return', value: ref('sum') },
    ])
    const sumCode = compileContentGraph(sumGraph).code
    const sum = new Function(`return (${sumCode})`)() as () => unknown
    expect(sum()).toBe(3)

    const continueBody: ContentGraphRegion = {
      entry: 'check', end: 'continue-end', nodes: [
        { id: 'check', kind: 'branch', condition: { kind: 'binary', op: '===', left: ref('i'), right: literal(1) }, yes: 'continue', no: 'add' },
        { id: 'continue', kind: 'continue' },
        { id: 'add', kind: 'set', target: { kind: 'ref', name: 'sum' }, operator: '+=', value: ref('i'), next: 'continue-end' },
        { id: 'continue-end', kind: 'regionEnd' },
      ],
    }
    const continueGraph = graph('skill', [
      { id: 'init-i', kind: 'bind', name: 'i', expr: literal(0), next: 'init-sum' },
      { id: 'init-sum', kind: 'bind', name: 'sum', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'for', condition: { kind: 'binary', op: '<', left: ref('i'), right: literal(3) }, body: continueBody, update, next: 'done' },
      { id: 'done', kind: 'return', value: ref('sum') },
    ])
    const continueCode = compileContentGraph(continueGraph).code
    const continueLoop = new Function(`return (${continueCode})`)() as () => unknown
    expect(continueLoop()).toBe(2)
  })

  it('keeps nested break local and preserves return from a loop region', () => {
    const innerBody: ContentGraphRegion = {
      entry: 'inner-check', end: 'inner-end', nodes: [
        { id: 'inner-check', kind: 'branch', condition: { kind: 'binary', op: '===', left: ref('j'), right: literal(1) }, yes: 'inner-break', no: 'inner-add' },
        { id: 'inner-break', kind: 'break' },
        { id: 'inner-add', kind: 'set', target: { kind: 'ref', name: 'sum' }, operator: '+=', value: literal(1), next: 'inner-end' },
        { id: 'inner-end', kind: 'regionEnd' },
      ],
    }
    const innerUpdate: ContentGraphRegion = {
      entry: 'inner-update', end: 'inner-update-end', nodes: [
        { id: 'inner-update', kind: 'set', target: { kind: 'ref', name: 'j' }, operator: '+=', value: literal(1), next: 'inner-update-end' },
        { id: 'inner-update-end', kind: 'regionEnd' },
      ],
    }
    const outerBody: ContentGraphRegion = {
      entry: 'reset-j', end: 'outer-end', nodes: [
        { id: 'reset-j', kind: 'bind', name: 'j', expr: literal(0), next: 'inner-loop' },
        { id: 'inner-loop', kind: 'loop', loop: 'for', condition: { kind: 'binary', op: '<', left: ref('j'), right: literal(3) }, body: innerBody, update: innerUpdate, next: 'outer-end' },
        { id: 'outer-end', kind: 'regionEnd' },
      ],
    }
    const outerUpdate: ContentGraphRegion = {
      entry: 'outer-update', end: 'outer-update-end', nodes: [
        { id: 'outer-update', kind: 'set', target: { kind: 'ref', name: 'i' }, operator: '+=', value: literal(1), next: 'outer-update-end' },
        { id: 'outer-update-end', kind: 'regionEnd' },
      ],
    }
    const nestedGraph = graph('skill', [
      { id: 'init-i', kind: 'bind', name: 'i', expr: literal(0), next: 'init-sum' },
      { id: 'init-sum', kind: 'bind', name: 'sum', expr: literal(0), next: 'outer-loop' },
      { id: 'outer-loop', kind: 'loop', loop: 'for', condition: { kind: 'binary', op: '<', left: ref('i'), right: literal(2) }, body: outerBody, update: outerUpdate, next: 'done' },
      { id: 'done', kind: 'return', value: ref('sum') },
    ])
    const nestedCode = compileContentGraph(nestedGraph).code
    const nested = new Function(`return (${nestedCode})`)() as () => unknown
    expect(nested()).toBe(2)

    const returnBody: ContentGraphRegion = {
      entry: 'check', end: 'return-end', nodes: [
        { id: 'check', kind: 'branch', condition: { kind: 'binary', op: '===', left: ref('i'), right: literal(1) }, yes: 'early-return', no: 'increment' },
        { id: 'early-return', kind: 'return', value: literal('early') },
        { id: 'increment', kind: 'set', target: { kind: 'ref', name: 'i' }, operator: '+=', value: literal(1), next: 'return-end' },
        { id: 'return-end', kind: 'regionEnd' },
      ],
    }
    const returnGraph = graph('skill', [
      { id: 'init-i', kind: 'bind', name: 'i', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'while', condition: { kind: 'binary', op: '<', left: ref('i'), right: literal(3) }, body: returnBody, next: 'done' },
      { id: 'done', kind: 'return', value: literal('done') },
    ])
    const returnCode = compileContentGraph(returnGraph).code
    const returnLoop = new Function(`return (${returnCode})`)() as () => unknown
    expect(returnLoop()).toBe('early')
  })

  it('rejects unstructured region edges and preserves long finite loops', () => {
    const badEnd = graph('skill', [
      { id: 'init', kind: 'bind', name: 'i', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'while', condition: literal(false), body: { entry: 'body', end: 'body-end', nodes: [{ id: 'body', kind: 'regionEnd' }, { id: 'body-end', kind: 'return' }] }, next: 'done' },
      { id: 'done', kind: 'return' },
    ])
    expect(() => compileContentGraph(badEnd)).toThrow('end 必须指向 regionEnd')

    const nonDominatingLoopLocal = graph('skill', [
      { id: 'branch', kind: 'branch', condition: literal(true), yes: 'declared', no: 'loop' },
      { id: 'declared', kind: 'bind', name: 'branchOnly', expr: literal(1), next: 'loop' },
      {
        id: 'loop', kind: 'loop', loop: 'while', condition: literal(false), next: 'done',
        body: {
          entry: 'body-return', end: 'body-end', nodes: [
            { id: 'body-return', kind: 'return', value: ref('branchOnly') },
            { id: 'body-end', kind: 'regionEnd' },
          ],
        },
      },
      { id: 'done', kind: 'return' },
    ])
    expect(() => compileContentGraph(nonDominatingLoopLocal)).toThrow('引用')

    const backedge = graph('skill', [
      { id: 'loop', kind: 'loop', loop: 'while', condition: literal(true), body: { entry: 'body', end: 'end', nodes: [{ id: 'body', kind: 'set', target: { kind: 'ref', name: 'missing' }, operator: '=', value: literal(1), next: 'body' }, { id: 'end', kind: 'regionEnd' }] }, next: 'done' },
      { id: 'done', kind: 'return' },
    ])
    expect(() => compileContentGraph(backedge)).toThrow('backedge')

    const hiddenLocal = graph('skill', [
      { id: 'loop', kind: 'loop', loop: 'while', condition: literal(false), body: { entry: 'local', end: 'local-end', nodes: [{ id: 'local', kind: 'bind', name: 'inside', expr: literal(1), next: 'local-end' }, { id: 'local-end', kind: 'regionEnd' }] }, next: 'done' },
      { id: 'done', kind: 'return', value: ref('inside') },
    ])
    expect(() => compileContentGraph(hiddenLocal)).toThrow('surface skill 不提供输入引用')

    const tooWide = graph('skill', [
      { id: 'init', kind: 'bind', name: 'i', expr: literal(0), next: 'loop' },
      { id: 'loop', kind: 'loop', loop: 'while', condition: { kind: 'binary', op: '<', left: ref('i'), right: literal(2000) }, body: { entry: 'inc', end: 'end', nodes: [{ id: 'inc', kind: 'set', target: { kind: 'ref', name: 'i' }, operator: '+=', value: literal(1), next: 'end' }, { id: 'end', kind: 'regionEnd' }] }, next: 'done' },
      { id: 'done', kind: 'return', value: ref('i') },
    ])
    const execute = new Function(`return (${compileContentGraph(tooWide).code})`)() as () => unknown
    expect(execute()).toBe(2000)
  })

  it('rejects raw code, unsafe paths, unsupported capabilities, cycles and non-dominating refs', () => {
    const base = graph('skill', [{ id: 'start', kind: 'return', value: literal(true) }])
    expect(() => compileContentGraph({ ...base, nodes: [{ ...base.nodes[0], kind: 'code' } as never] })).toThrow('不支持的节点类型')
    expect(() => compileContentGraph(graph('skill', [{ id: 'start', kind: 'return', value: ref('context.__proto__') }]))).toThrow('不安全')
    expect(() => compileContentGraph(graph('rule', [{ id: 'start', kind: 'call', capability: 'selectTarget', args: [literal({} as never)], next: 'done' } as never, { id: 'done', kind: 'return' }]))).toThrow('禁止')
    expect(() => compileContentGraph(graph('skill', [{ id: 'start', kind: 'branch', condition: literal(true), yes: 'start', no: 'done' }, { id: 'done', kind: 'return' }]))).toThrow('循环')

    const branch = graph('skill', [
      { id: 'start', kind: 'branch', condition: literal(true), yes: 'bind', no: 'skip' },
      { id: 'bind', kind: 'bind', name: 'value', expr: literal(1), next: 'merge' },
      { id: 'skip', kind: 'bind', name: 'other', expr: literal(0), next: 'merge' },
      { id: 'merge', kind: 'return', value: ref('value') },
    ])
    expect(() => compileContentGraph(branch)).toThrow('前置路径')
    expect(() => compileContentGraph(graph('skill', [{ id: 'start', kind: 'bind', name: 'return', expr: literal(1), next: 'done' }, { id: 'done', kind: 'return' }]))).toThrow('bind.name 无效')

    let nested: ContentGraphExpression = { kind: 'get', object: literal(1), key: 'value' }
    for (let index = 0; index < 129; index += 1) nested = { kind: 'get', object: nested, key: 'value' }
    expect(() => compileContentGraph(graph('skill', [{ id: 'start', kind: 'return', value: nested }]))).toThrow('嵌套深度')

    const assignment = (target: ContentGraphSetTarget): ContentGraph => graph('skill', [
      { id: 'set', kind: 'set', target, operator: '=', value: literal(1), next: 'return' },
      { id: 'return', kind: 'return' },
    ])
    expect(() => compileContentGraph(assignment({ kind: 'ref', name: 'context' }))).toThrow('不能替换入口')
    expect(() => compileContentGraph(assignment({ kind: 'get', object: ref('context'), key: '__proto__' }))).toThrow('原型')
    expect(() => compileContentGraph(assignment({ kind: 'index', object: ref('context'), index: literal('__proto__') }))).toThrow('原型')
    const dynamicIndex = compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: {
        kind: 'index', object: get(ref('context'), 'values'), index: get(ref('context'), 'key'),
      },
    }]))
    const executeDynamicIndex = new Function(`return (${dynamicIndex.code})`)() as (value: { values: Record<string, unknown>; key: string }) => unknown
    expect(() => executeDynamicIndex({ values: {}, key: '__proto__' })).toThrow('unsafe content graph index')
    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: {
        kind: 'collection', object: { kind: 'array', items: [literal(1)] }, method: 'filter', args: [literal(true)],
      },
    }]))).toThrow('lambda')
    expect(() => compileContentGraph(graph('skill', [{
      id: 'return', kind: 'return', value: { kind: 'lambda', parameters: ['context'], body: literal(true) },
    }]))).toThrow('参数名')
  })

  it('changes only the selected generated field and verifies the attached artifact', () => {
    const contentGraph = graph('preview', [{ id: 'start', kind: 'return', value: literal('generated') }])
    const original = { id: 'piece-skill', description: '原文字段', targeting: { steps: [] }, previewCode: 'old' }
    const applied = applyContentGraph(original, contentGraph, 'previewCode')
    expect(applied.description).toBe(original.description)
    expect(applied.targeting).toEqual(original.targeting)
    expect(applied.previewCode).toContain('function calculatePreview')
    expect(applied.contentGraphField).toBe('previewCode')
    expect(() => assertContentGraphArtifact(applied)).not.toThrow()
    expect(() => assertContentGraphArtifact({ ...applied, previewCode: 'tampered' })).toThrow('不一致')
    expect(() => applyContentGraph({ skillGraph: { version: 'old' } }, contentGraph, 'previewCode')).toThrow('旧 skillGraph')

    const ruleApplied = applyContentGraph({ skillCode: 'old rule body' }, graph('rule', [{ id: 'start', kind: 'return', value: literal(true) }]))
    expect(ruleApplied.contentGraphField).toBe('skillCode')
    expect(ruleApplied.skillCode).toContain('return true')
  })
})
