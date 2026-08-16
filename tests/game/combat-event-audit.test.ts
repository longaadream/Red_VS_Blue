/* eslint-disable @typescript-eslint/no-explicit-any -- audit fixtures intentionally exercise heterogeneous runtime event shapes */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'
import { EventTraceProbe } from '../helpers/event-trace'

const rule = (id: string, priority: number, run: () => any, eventType = 'audit') => ({
  id, name: id, description: id, priority, trigger: { type: eventType }, effect: () => run(),
})

describe('RED-45 event audit', () => {
  it('records parent-child metadata for nested fireEvent dispatches', () => {
    const system = new TriggerSystem()
    system.addRules([
      rule('parent', 1, () => system.fireEvent(state, parentContext, 'child'), 'parent'),
      rule('child', 1, () => ({ success: true }), 'child'),
    ] as any)
    const state = makeState() as any
    const parentContext: any = { type: 'parent' }

    const result = system.checkTriggers(state, parentContext)

    expect(result.eventChain).toEqual([
      expect.objectContaining({ eventId: 'event-1:1', type: 'parent', depth: 0 }),
      expect.objectContaining({ eventId: 'event-1:2', parentEventId: 'event-1:1', type: 'child', depth: 1 }),
    ])
  })

  it('stops a recursive fireEvent chain at the configured depth with the full chain', () => {
    const system = new TriggerSystem()
    const state = makeState() as any
    let terminal: any
    const recurse = (context: any) => system.fireEvent(state, context, 'loop')
    system.addRules([{
      id: 'loop', name: 'loop', description: 'loop', trigger: { type: 'loop' },
      effect: (_battle: any, context: any) => {
        if ((context.eventDepth ?? 0) < 19) {
          terminal = recurse(context)
          return terminal
        }
        return { success: true }
      },
    }] as any)

    const loopContext: any = { type: 'loop' }
    const result = system.checkTriggers(state, loopContext)

    expect(result.eventChain).toHaveLength(20)
    terminal = system.fireEvent(state, { type: 'loop', eventId: 'event-1:20', rootEventId: 'event-1', eventDepth: 19, eventChain: loopContext.eventChain }, 'loop')
    expect(terminal.error).toMatchObject({ code: 'EVENT_CHAIN_DEPTH_EXCEEDED' })
    expect(terminal.error.eventChain).toHaveLength(20)
  })

  it('stops a wide fireEvent chain after the dispatch budget', () => {
    const system = new TriggerSystem()
    const state = makeState() as any
    const children: any[] = []
    system.addRules([{
      id: 'root', name: 'root', description: 'root', trigger: { type: 'root' },
      effect: (_battle: any, context: any) => {
        for (let index = 0; index < 100; index++) children.push(system.fireEvent(state, context, 'child'))
        return { success: true }
      },
    }, rule('child', 1, () => ({ success: true }), 'child')] as any)

    const result = system.checkTriggers(state, { type: 'root' })

    expect(children.at(-1).error).toMatchObject({ code: 'EVENT_CHAIN_BUDGET_EXCEEDED' })
    expect(children.at(-1).error.eventChain).toHaveLength(100)
    expect(result.eventChain).toHaveLength(100)
  })
  it('keeps summon event producers aligned with TriggerType', () => {
    let output = ''
    try { output = execFileSync(process.execPath, ['scripts/audit-combat-events.mjs'], { encoding: 'utf8' }) }
    catch (error: any) { output = error.stdout }
    const report = JSON.parse(output)
    const summonEvents = report.events.filter((entry: any) => entry.event.includes('PieceSummon'))

    expect(summonEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'beforePieceSummoned', declared: true, producers: expect.arrayContaining(['lib/game/turn.ts']) }),
      expect.objectContaining({ event: 'afterPieceSummoned', declared: true, producers: expect.arrayContaining(['lib/game/battle-setup.ts', 'lib/game/turn.ts']) }),
    ]))
    expect(summonEvents.map((entry: any) => entry.event)).not.toEqual(expect.arrayContaining(['beforePieceSummon', 'afterPieceSummon']))
    expect(report.emittedOnly).toEqual([])
    expect(report.events.map((entry: any) => entry.event)).not.toContain('triggerEffect')
    expect(report.dynamicCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'lib/game/turn.ts', context: 'resumeCtx' }),
    ]))
  })

  it('observes global then piece then player ordering, with descending rule priority', () => {
    const seen: string[] = []
    const system = new TriggerSystem()
    system.addRules([rule('global-low', 1, () => { seen.push('global-low'); return { success: true } }), rule('global-high', 2, () => { seen.push('global-high'); return { success: true } })] as any)
    const piece = makePiece({ rules: [rule('piece', 0, () => { seen.push('piece'); return { success: true } })] })
    const state = makeState({ pieces: [piece] }) as any
    state.players[0].rules = [rule('player', 0, () => { seen.push('player'); return { success: true } })]
    system.checkTriggers(state, { type: 'audit', playerId: 'player-red' })
    expect(seen).toEqual(['global-high', 'global-low', 'piece', 'player'])
  })

  it('observes blocked and exception semantics without declaring them correct', () => {
    const seen: string[] = []
    const system = new TriggerSystem()
    system.addRules([
      rule('throws', 3, () => { seen.push('throws'); throw new Error('audit') }),
      rule('blocks', 2, () => { seen.push('blocks'); return { success: true, blocked: true } }),
      rule('after', 1, () => { seen.push('after'); return { success: true } }),
    ] as any)
    const result = system.checkTriggers(makeState() as any, { type: 'audit' })
    expect(seen).toEqual(['throws', 'blocks'])
    expect(result.blocked).toBe(true)
  })

  it('records deterministic test-side event evidence', () => {
    const probe = new EventTraceProbe()
    const state = makeState()
    const before = probe.snapshotContext({ type: 'audit', damage: 3 })
    probe.record({ actionId: 'fixed-action', depth: 0, eventType: 'audit', consumerKind: 'globalRule', consumerId: 'rule-a', priority: 2, contextBefore: before, contextAfter: before, success: true, blocked: false, stateHash: probe.snapshotState(state) })
    expect(probe.all()).toEqual([expect.objectContaining({ eventId: 'fixed-action:1', sequence: 1, stateHash: probe.snapshotState(state) })])
  })

  it('observes pending queues and does not execute later rules in the initial pass', () => {
    const seen: string[] = []
    const system = new TriggerSystem()
    system.addRules([
      rule('asks', 2, () => ({ needsOptionSelection: true, title: 'choose', options: ['x'] })),
      rule('later', 1, () => { seen.push('later'); return { success: true } }),
    ] as any)
    const result = system.checkTriggers(makeState() as any, { type: 'audit' }) as any
    expect(result.needsOptionSelection).toBe(true)
    expect(result.pendingQueue).toEqual([{ ruleId: 'later', sourceId: undefined }])
    expect(seen).toEqual([])
  })

  it('observes attached effects still run after a reactive-card attempt', () => {
    const seen: string[] = []
    const state = makeState({ pieces: [makePiece()] }) as any
    state.players[0].hand = [{ cardId: 'audit-card', instanceId: 'card-1', ownerPlayerId: 'player-red' }]
    state.customCards = { 'audit-card': { id: 'audit-card', name: 'audit', type: 'reactive', trigger: { type: 'audit' }, code: "function executeCard(context) { context.battle.extensions.auditSeen.push('card'); return { success: true }; }" } }
    state.extensions.auditSeen = seen
    state.pieces[0].attachedEffects = [{ instanceId: 'effect-1', definitionId: 'effect-1', ownerId: state.pieces[0].instanceId, data: {}, triggers: [{ on: 'audit', filterCode: 'function() { return true }', effectCode: "function(ctx, battle) { battle.extensions.auditSeen.push('effect'); return { success: true } }" }] }]
    new TriggerSystem().checkTriggers(state, { type: 'audit', playerId: 'player-red' })
    // The intentionally minimal custom card is not loaded by the production card repository;
    // this proves the trigger system catches the card-path failure and continues to effects.
    expect(seen).toEqual(['effect'])
  })
})
