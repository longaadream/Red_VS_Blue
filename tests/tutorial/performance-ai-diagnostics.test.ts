import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const start = page.indexOf('    function tutorialPerfAiDecisionResult(')
const end = page.indexOf('\n    function ', start + 10)
const callback = page.slice(start, end)

function runtimeFunction(name: string): string {
  const marker = `function ${name}(`
  const start = page.indexOf(marker)
  if (start < 0) throw new Error(`Missing page function: ${name}`)
  const bodyStart = page.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    if (page[index] !== '}') continue
    depth -= 1
    if (depth === 0) return page.slice(start, index + 1)
  }
  throw new Error(`Unclosed page function: ${name}`)
}

describe('tutorial AI page diagnostics', () => {
  it('retains bounded search evidence in the existing opt-in action record', () => {
    const record = { kind: 'ai-search', counters: {} }
    const details = {
      action: { type: 'endTurn' }, requestMs: 20, decisionMs: 10,
      nodes: 0, considered: 12, stopReason: 'time-budget', score: 42,
      overTurnBudget: true, overDecisionBudget: false,
      actionsTakenThisTurn: 0,
      continuation: { turnKey: 'blue:2:blue', nodes: 16, elapsedMs: 2501 },
      trace: [{ depth: 0, candidateId: 'move-id', rootId: 'move-id', reason: 'candidate-limit' }],
      traceCounts: { evaluated: 0, 'candidate-limit': 12 },
    }
    runInNewContext(`${callback}\ntutorialPerfAiDecisionResult(details)`, { tutorialPerfActive: record, details })
    expect(record).toMatchObject({
      score: 42, overTurnBudget: true, overDecisionBudget: false,
      continuation: details.continuation, rootTrace: details.trace,
      traceCounts: details.traceCounts,
    })
  })

  it('does not create a record when performance diagnostics are disabled', () => {
    const sandbox = { tutorialPerfActive: null, details: { overTurnBudget: true } }
    runInNewContext(`${callback}\ntutorialPerfAiDecisionResult(details)`, sandbox)
    expect(sandbox.tutorialPerfActive).toBeNull()
  })

  it('gates AI replay capture to an opted-in loopback tutorial', () => {
    const source = runtimeFunction('tutorialAiReplayCaptureEnabled')
    const sandbox: {
      TUTORIAL_MODE: boolean
      params: URLSearchParams
      location: { hostname: string }
      tutorialAiReplayCaptureEnabled?: () => boolean
    } = {
      TUTORIAL_MODE: true,
      params: new URLSearchParams('lesson=tactical-intuition&tutorialPerf=1'),
      location: { hostname: '127.0.0.1' },
    }
    runInNewContext(source, sandbox)
    expect(sandbox.tutorialAiReplayCaptureEnabled!()).toBe(true)

    sandbox.location.hostname = 'qa.example.test'
    expect(sandbox.tutorialAiReplayCaptureEnabled!()).toBe(false)
    sandbox.location.hostname = 'localhost'
    sandbox.params = new URLSearchParams('lesson=tactical-intuition')
    expect(sandbox.tutorialAiReplayCaptureEnabled!()).toBe(false)
    sandbox.params = new URLSearchParams('lesson=tactical-intuition&tutorialPerf=1')
    sandbox.TUTORIAL_MODE = false
    expect(sandbox.tutorialAiReplayCaptureEnabled!()).toBe(false)
  })

  it('serializes only the first two replay inputs and keeps them when ordinary records roll off', () => {
    const result = runtimeFunction('tutorialPerfAiDecisionResult')
    const finish = runtimeFunction('tutorialPerfFinishNow')
    const record = (action = 'endTurn') => ({
      kind: 'ai-search', counters: {}, action,
      stages: {}, _startedAt: 0, _rafFrames: 0, _requestRafFrames: 0,
    })
    type ReplayState = {
      skillsById?: Record<string, unknown>
      turn: { turnNumber: number }
      pieces: Array<{ id: string }>
      [key: string]: unknown
    }
    type ReplayInput = {
      state: ReplayState
      rootSeed: number
      playerId: string
      continuation: { turnKey: string; nodes: number; elapsedMs: number } | null
      actionsTakenThisTurn: number
    }
    const state: ReplayInput['state'] = { skillsById: { hidden: true }, turn: { turnNumber: 2 }, pieces: [{ id: 'blue' }] }
    const replayInput: ReplayInput = {
      state,
      rootSeed: 18707,
      playerId: 'training-blue',
      continuation: { turnKey: 'blue:2:blue', nodes: 4, elapsedMs: 8 },
      actionsTakenThisTurn: 0,
    }
    const sandbox: Record<string, unknown> = {
      tutorialPerfActive: record(), tutorialPerfRecords: [], tutorialPerfReplayCount: 0, tutorialPerfReplayLimit: 2,
      tutorialPerfNow: () => 1, tutorialPerfStopFrameCounter: () => {}, tutorialPerfSync: () => {},
      tutorialPerfRafHandle: null, tutorialPerfRafTimer: null,
      details: {
        action: { type: 'endTurn', playerId: 'training-blue' },
        replayInput,
        replayResult: { action: { type: 'endTurn' }, score: 2 },
      },
    }
    const capture = (active: unknown, input: ReplayInput) => {
      sandbox.tutorialPerfActive = active
      sandbox.details = {
        action: { type: 'endTurn', playerId: 'training-blue' },
        replayInput: input,
        replayResult: { action: { type: 'endTurn' }, score: 2 },
      }
      runInNewContext(`${result}\ntutorialPerfAiDecisionResult(details)`, sandbox)
    }
    capture(record(), replayInput)
    const first = sandbox.tutorialPerfActive as { aiReplay: { input: ReplayInput; result: Record<string, unknown> } }
    expect(first.aiReplay.input.state.skillsById).toBeUndefined()
    expect(first.aiReplay.input).toMatchObject({ rootSeed: 18707, playerId: 'training-blue', actionsTakenThisTurn: 0 })
    expect(first.aiReplay.result).toMatchObject({ action: { type: 'endTurn' }, score: 2 })
    state.pieces[0].id = 'mutated'
    expect(first.aiReplay.input.state.pieces[0].id).toBe('blue')

    const secondState: ReplayState = { turn: { turnNumber: 3 }, pieces: [{ id: 'second' }] }
    const secondInput = { ...replayInput, state: secondState }
    capture(record(), secondInput)
    const second = sandbox.tutorialPerfActive as { aiReplay: unknown }
    expect(second.aiReplay).toBeDefined()

    capture(record(), { ...replayInput, state: { turn: { turnNumber: 4 }, pieces: [] } })
    expect((sandbox.tutorialPerfActive as { aiReplay?: unknown }).aiReplay).toBeUndefined()

    const records = sandbox.tutorialPerfRecords as Array<{ aiReplay?: unknown; kind: string }>
    records.push(first as unknown as { aiReplay: unknown; kind: string })
    records.push(second as unknown as { aiReplay: unknown; kind: string })
    for (let index = 0; index < 25; index += 1) records.push({ kind: 'normal' })
    sandbox.tutorialPerfActive = record('normal')
    sandbox.tutorialPerfReplayCount = 1
    sandbox.tutorialPerfRecords = records
    // The finish helper owns the bounded retention policy in the page.
    runInNewContext(`${finish}\ntutorialPerfFinishNow(tutorialPerfActive)`, sandbox)
    expect((sandbox.tutorialPerfRecords as unknown[]).length).toBeLessThanOrEqual(20)
    expect((sandbox.tutorialPerfRecords as Array<{ aiReplay?: unknown }>).some(item => item.aiReplay)).toBe(true)
  })
})
