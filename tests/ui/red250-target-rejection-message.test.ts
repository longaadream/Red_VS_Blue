/* eslint-disable @typescript-eslint/no-explicit-any -- battle.html runs in a browser VM. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')

function source(name: string) {
  const marker = `function ${name}(`
  const start = page.indexOf(marker)
  if (start < 0) throw new Error(`Missing function: ${name}`)
  const bodyStart = page.indexOf('{', start + marker.length)
  let depth = 0
  for (let index = bodyStart; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    else if (page[index] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, index + 1)
    }
  }
  throw new Error(`Unclosed function: ${name}`)
}

function asyncSource(name: string) {
  const marker = `async function ${name}(`
  const start = page.indexOf(marker)
  if (start < 0) throw new Error(`Missing async function: ${name}`)
  const bodyStart = page.indexOf('{', start + marker.length)
  let depth = 0
  for (let index = bodyStart; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    else if (page[index] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, index + 1)
    }
  }
  throw new Error(`Unclosed async function: ${name}`)
}

function loadMessageFormatter() {
  const context = createContext({})
  new Script(source('targetRejectionMessage')).runInContext(context)
  return context
}

describe('RED-250 target rejection messages', () => {
  it('maps known target errors to stable user-facing messages', () => {
    const context = loadMessageFormatter()
    const cases = [
      ['TARGET_SELECTION_STALE', 'revision 9', '目标选择已过期，请重新选择'],
      ['TARGET_SELECTION_ID_MISMATCH', 'selection-id-internal', '目标选择已过期，请重新选择'],
      ['TARGET_SELECTION_PLAYER_MISMATCH', 'player-blue', '当前玩家无法完成此目标选择'],
      ['TARGET_REFERENCE_MISMATCH', 'piece-internal is not at (2,3)', '目标位置已变化，请重新选择'],
      ['TARGET_NOT_WALKABLE', 'Cell (2,3) is not walkable', '所选地格不可行走'],
      ['TARGET_OUT_OF_RANGE', 'Target is out of range', '目标超出允许范围'],
      ['TARGET_TYPE_MISMATCH', 'Expected cell target', '目标类型不匹配，请重新选择'],
      ['TARGET_OCCUPIED', 'Cell (2,3) is occupied', '所选地格已被占用'],
      ['TARGET_FILTER_MISMATCH', 'Target must be an enemy', '目标不在合法候选中'],
      ['TARGET_NOT_FOUND', 'Piece secret-id was not found', '目标不在合法候选中'],
    ]

    for (const [code, rawMessage, expected] of cases) {
      const result = new Script(`targetRejectionMessage(${JSON.stringify(code)}, ${JSON.stringify(rawMessage)})`)
        .runInContext(context as any)
      expect(result, code).toBe(expected)
    }
  })

  it('preserves an unknown rejection message verbatim', () => {
    const context = loadMessageFormatter()
    const rawMessage = 'Unexpected authority failure for secret-internal-id'

    const result = new Script(`targetRejectionMessage('UNEXPECTED_AUTHORITY_ERROR', ${JSON.stringify(rawMessage)})`)
      .runInContext(context as any)

    expect(result).toBe(rawMessage)
  })

  it('keeps the raw rejection message in training evidence while presenting the mapped text', async () => {
    const rawMessage = 'Cell (4,2) is not walkable'
    const statuses: string[] = []
    const logs: string[] = []
    const evidence = { rejections: [] as Array<Record<string, unknown>> }
    const rejectionFeedback: string[] = []
    const context = createContext({
      G: { pendingTargetSelection: null, pendingOptionSelection: null },
      TUTORIAL_MODE: false,
      targetSubmissionPending: null,
      pendingSkill: null,
      pendingCardAction: null,
      _pendingChoiceShown: null,
      red50Evidence: evidence,
      window: { RvBGameEngine: { ensure: async () => ({}) } },
      document: { getElementById: () => ({ disabled: false }) },
      setMoveButtonDisabled: () => undefined,
      trainingApiFetch: async () => {
        const error = Object.assign(new Error(rawMessage), { code: 'TARGET_NOT_WALKABLE' })
        throw error
      },
      rejectPendingActionFeedback: (_reason: string, message: string) => rejectionFeedback.push(message),
      renderActionBar: () => undefined,
      setStatusMsg: (message: string) => statuses.push(message),
      addLog: (message: string) => logs.push(message),
      console: { error: () => undefined },
    })
    new Script([
      source('targetRejectionCanRetry'),
      source('targetRejectionMessage'),
      source('shouldRetainTargetAfterRejection'),
      asyncSource('trainingDoAction'),
    ].join('\n')).runInContext(context)

    await new Script("trainingDoAction({ type: 'playCard', playerId: 'player-red' })")
      .runInContext(context as any)

    expect(evidence.rejections).toEqual([
      expect.objectContaining({ code: 'TARGET_NOT_WALKABLE', message: rawMessage }),
    ])
    expect(rejectionFeedback).toEqual([`操作被拒绝：所选地格不可行走；目标选择已清除`])
    expect(statuses.at(-1)).toBe('操作被拒绝：所选地格不可行走；目标选择已清除')
    expect(logs.at(-1)).toContain('所选地格不可行走')
    expect(logs.at(-1)).not.toContain(rawMessage)
  })
})
