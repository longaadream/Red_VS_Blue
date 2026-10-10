import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const start = page.indexOf('    function tutorialPerfAiDecisionResult(')
const end = page.indexOf('\n    function ', start + 10)
const callback = page.slice(start, end)

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
})
