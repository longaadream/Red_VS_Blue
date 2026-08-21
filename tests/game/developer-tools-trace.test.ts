import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { toPublicBattleState } from '@/lib/game/deployment'
import { makeState } from '../helpers/minimal-state'

function terminalResult() {
  return {
    status: 'finished' as const,
    winnerPlayerId: 'player-red',
    loserPlayerId: 'player-blue',
    reason: 'surrender' as const,
    settledAt: {
      actionIndex: 4,
      actionType: 'surrender' as const,
      actorPlayerId: 'player-blue',
      turnNumber: 3,
      phase: 'action' as const,
      completedRound: 2,
    },
  }
}

function tracedState(finished: boolean) {
  const state = makeState({ turnNumber: 3 })
  state.extensions = {
    debugBattle: {
      appliedActionIds: ['action-secret-id'],
      actionLog: [{
        index: 0,
        rootSeed: 9876,
        actionId: 'command-1',
        actionHash: 'action-hash',
        tick: 0,
        turn: 1,
        playerId: 'player-red',
        preStateHash: 'pre-hash',
        postStateHash: 'post-hash',
        randomStreams: [],
      }],
      commandLog: [{
        type: 'beginPhase',
        authorization: { token: 'must-not-leak' },
        signature: 'must-not-leak',
      }],
    },
  }
  if (finished) state.terminalResult = terminalResult()
  return state
}

function loadTraceTools() {
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/developer-tools/match-trace.js'),
    'utf8',
  )
  const storage = new Map<string, string>()
  const context = createContext({
    window: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
    },
    Blob,
    URL: {
      createObjectURL: () => 'blob:trace',
      revokeObjectURL: () => undefined,
    },
    document: {
      createElement: () => ({ click: () => undefined, remove: () => undefined }),
      body: { appendChild: () => undefined },
    },
    setTimeout: (callback: () => void) => callback(),
  })
  new Script(source, { filename: 'match-trace.js' }).runInContext(context)
  return (context.window as any).RvBDeveloperTools
}

describe('developer tools match trace boundary', () => {
  it('hides the complete command trace from every active public battle snapshot', () => {
    const projected = toPublicBattleState(tracedState(false))

    expect(projected.extensions?.debugBattle).toEqual({
      appliedActionIds: [],
      actionLog: [],
    })
  })

  it('exposes a sanitized complete trace only after the authoritative terminal result', () => {
    const projected = toPublicBattleState(tracedState(true))
    const metadata = projected.extensions?.debugBattle

    expect(metadata.appliedActionIds).toEqual([])
    expect(metadata.actionLog).toHaveLength(1)
    expect(metadata.actionLog[0].action).toEqual({ type: 'beginPhase' })
    expect(JSON.stringify(metadata)).not.toContain('must-not-leak')
  })

  it('creates and stores a versioned downloadable trace only for completed matches', () => {
    const tools = loadTraceTools()
    const activeState = tracedState(false)
    const finishedState = toPublicBattleState(tracedState(true))

    expect(() => tools.createTraceRecord({ state: activeState, roomId: 'room-active' }))
      .toThrow(/terminal/i)

    const record = tools.createTraceRecord({
      state: finishedState,
      roomId: 'room-finished',
      seed: 9876,
      authorityVersion: 12,
      exportedAt: '2026-08-21T12:00:00.000Z',
    })
    tools.storeCompletedTrace(record)

    expect(record).toMatchObject({
      format: 'rvb-match-trace/v1',
      roomId: 'room-finished',
      seed: 9876,
      authorityVersion: 12,
      exportedAt: '2026-08-21T12:00:00.000Z',
      final: {
        stateVersion: 1,
        mapId: 'test-map',
        turnNumber: 3,
        winnerPlayerId: 'player-red',
        reason: 'surrender',
      },
      summary: {
        commandCount: 1,
        playerCount: 2,
      },
    })
    expect(record.trace).toHaveLength(1)
    expect(JSON.stringify(record)).not.toContain('must-not-leak')
    expect(toPlainObject(tools.readStoredTrace())).toEqual(toPlainObject(record))
  })
})

function toPlainObject(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}
