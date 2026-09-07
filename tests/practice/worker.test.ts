import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readClientProtocolBattleData } from '@/electron-client/client-protocol-resource'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { AI_ID, HUMAN_ID } from '@/lib/practice/setup'

function worker() {
  const files = readClientProtocolBattleData({ htmlRoot: path.resolve('data/pages'), appRoot: process.cwd(), activePackRoot: null, isPackaged: false })
  files['data/rules/rule-lucky-coin-gamestart.json'] = JSON.parse(fs.readFileSync('data/rules/rule-lucky-coin-gamestart.json', 'utf8'))
  const messages: Array<Record<string, unknown>> = []
  const context = vm.createContext({ __RVB_PRACTICE_FILES__: files, __RVB_PRACTICE_PROFILE__: getServerGameProfileIdentityV1(),
    process: { env: { NODE_ENV: 'production' }, cwd: () => '' }, console: { ...console, log() {}, info() {} }, performance,
    crypto: webcrypto, TextEncoder, TextDecoder, postMessage: (message: Record<string, unknown>) => messages.push(structuredClone(message)) })
  new vm.Script(fs.readFileSync('data/pages/js/practice/engine.js', 'utf8')).runInContext(context)
  expect(messages.pop()).toEqual({ ready: true })
  return async (type: string, payload?: unknown) => {
    await context.onmessage({ data: { id: 1, type, payload } })
    const result = messages.pop()!
    if (result.error) throw new Error(JSON.stringify(result.error))
    return result.result as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- wire protocol fixture
  }
}

describe('actual browser worker bundle with current desktop resources', () => {
  it.each([true, false])('runs three complete AI turns, humanFirst=%s', async humanFirst => {
    const request = worker()
    const human = await request('choose', { alignment: 'good', seed: 7 })
    const ai = await request('choose', { alignment: 'evil', seed: 8 })
    let result = await request('start', { human, ai, humanFirst, mapId: 'large-hole-arena', seed: 2003 })
    let steps = 0
    while (!result.state.terminalResult && !result.paused && (result.timings.filter((t: { complete: boolean }) => t.complete).length < 3) && steps++ < 65) {
      if (result.inputOwner === AI_ID) result = await request('step', { revision: result.revision })
      else {
        const state = result.state
        let action: Record<string, unknown>
        if (state.pendingOptionSelection) {
          const pending = state.pendingOptionSelection
          const values = pending.options.map((o: any) => o && typeof o === 'object' && 'value' in o ? o.value : o) // eslint-disable-line @typescript-eslint/no-explicit-any -- protocol
          action = { type: 'pendingOptionSelect', playerId: HUMAN_ID, selectionId: pending.selectionId, stateRevision: pending.stateRevision,
            selectedOption: pending.selectionMode === 'multi' ? values.slice(0, pending.minSelections ?? 1) : values[0] }
        } else if (state.pendingTargetSelection) {
          const pending = state.pendingTargetSelection
          fs.mkdirSync('output/pvp-practice', { recursive: true })
          fs.writeFileSync('output/pvp-practice/pending-smoke.json', JSON.stringify(pending, null, 2))
          const [first, ...rest] = pending.candidates.slice(0, pending.selectionMode === 'multi' ? (pending.minSelections ?? 1) : 1)
          action = { type: 'pendingTargetSelect', playerId: HUMAN_ID, selectionId: pending.selectionId, stateRevision: pending.stateRevision,
            ...(first?.type === 'piece' ? { targetPieceId: first.pieceId } : first ? { targetX: first.x, targetY: first.y } : {}),
            extraTargets: rest.map((ref: any) => ref.type === 'piece' ? { pieceId: ref.pieceId } : { x: ref.x, y: ref.y }) } // eslint-disable-line @typescript-eslint/no-explicit-any -- protocol
        } else if (state.deployment?.status === 'awaiting-reserve-deploy') {
          const deployment = state.deployment
          action = { type: 'deployReservePiece', playerId: HUMAN_ID, pieceId: deployment.offerPieces[0].instanceId, expectedDeploymentRevision: deployment.revision,
            ...(deployment.legalPositions.length ? { toX: deployment.legalPositions[0].x, toY: deployment.legalPositions[0].y } : {}) }
        } else action = { type: state.turn.phase === 'action' ? 'endTurn' : 'beginPhase', playerId: HUMAN_ID }
        result = await request('human', { action, revision: result.revision })
      }
    }
    const output = { humanFirst, steps, terminal: result.state.terminalResult, paused: result.paused, timings: result.timings }
    fs.mkdirSync('output/pvp-practice', { recursive: true })
    fs.writeFileSync(`output/pvp-practice/worker-smoke-${humanFirst ? 'human-first' : 'ai-first'}.json`, JSON.stringify(output, null, 2))
    expect(result.paused).toBeUndefined()
    expect(result.timings.filter((t: { complete: boolean }) => t.complete).length).toBeGreaterThanOrEqual(3)
    expect(result.timings.every((t: { computeMs: number }) => t.computeMs < 10000)).toBe(true)
  }, 90000)
})
