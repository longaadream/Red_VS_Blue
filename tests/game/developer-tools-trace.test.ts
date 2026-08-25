import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { toPublicBattleState } from '@/lib/game/deployment'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { createDebugDuel } from '@/lib/game/debug-battle'
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
  if (finished) state.terminalResult = terminalResult()
  const checkpoint = JSON.parse(JSON.stringify(state))
  delete checkpoint.extensions
  const checkpointHash = hashBattleState(checkpoint)
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
        preStateHash: checkpointHash,
        postStateHash: checkpointHash,
        randomStreams: [],
      }],
      commandLog: [{
        type: 'beginPhase',
        authorization: { token: 'must-not-leak' },
        signature: 'must-not-leak',
      }],
      replay: {
        format: 'rvb-battle-replay/v2',
        initialStateHash: checkpointHash,
        initialState: checkpoint,
        frames: [{
          index: 0,
          traceIndex: 0,
          action: { type: 'beginPhase' },
          actionType: 'beginPhase',
          playerId: 'player-red',
          turnBefore: 3,
          turnAfter: 3,
          phaseBefore: 'action',
          phaseAfter: 'action',
          preStateHash: checkpointHash,
          postStateHash: checkpointHash,
          postState: checkpoint,
          events: [{
            type: 'futureUnknownEvent',
            playerId: 'player-red',
            turn: 3,
            payload: { message: '仍然可以作为通用事件查看' },
          }],
          randomStreams: [],
        }],
      },
    },
  }
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
  it('hides the complete command trace and replay checkpoints from every active public battle snapshot', () => {
    const projected = toPublicBattleState(tracedState(false))

    expect(projected.extensions?.debugBattle).toEqual({
      appliedActionIds: [],
      actionLog: [],
    })
  })

  it('does not traverse server-only trace history while projecting an active match', () => {
    const state = tracedState(false)
    const privateTraceSentinel = new Proxy({}, {
      ownKeys: () => {
        throw new Error('active public projection traversed private trace history')
      },
    })
    const metadata = state.extensions?.debugBattle as any
    metadata.appliedActionIds = [privateTraceSentinel]
    metadata.actionLog = [privateTraceSentinel]
    metadata.commandLog = [privateTraceSentinel]
    metadata.replay = privateTraceSentinel

    expect(() => toPublicBattleState(state)).not.toThrow()
    expect(toPublicBattleState(state).extensions?.debugBattle).toEqual({
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
    expect(metadata.replay).toMatchObject({
      format: 'rvb-battle-replay/v2',
      initialState: expect.objectContaining({ map: expect.any(Object) }),
      frames: [expect.objectContaining({
        postState: expect.any(Object),
      })],
    })
    expect(JSON.stringify(metadata)).not.toContain('must-not-leak')
  })

  it('creates and stores a replayable v2 trace only for completed matches', async () => {
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
    await tools.storeCompletedTrace(record)

    expect(record).toMatchObject({
      format: 'rvb-match-trace/v2',
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
      initialState: expect.objectContaining({ map: expect.any(Object) }),
      frames: [expect.objectContaining({
        actionType: 'beginPhase',
        events: [expect.objectContaining({ type: 'futureUnknownEvent' })],
        postState: expect.any(Object),
      })],
    })
    expect(JSON.stringify(record)).not.toContain('must-not-leak')
    expect(toPlainObject(await tools.readStoredTrace())).toEqual(toPlainObject(record))
  })

  it('accepts a terminal v2 trace produced by the real seeded battle runner', async () => {
    const tools = loadTraceTools()
    const duel = await createDebugDuel({ seed: 4242, beginPhase: false })
    const finished = runBattleAction(duel.state, {
      type: 'surrender',
      playerId: 'debug-blue',
      reason: 'voluntary',
    }).state
    const projected = toPublicBattleState(finished)
    const record = tools.createTraceRecord({
      state: projected,
      roomId: 'runner-integration',
      seed: 4242,
    })

    expect(finished.terminalResult).toMatchObject({
      winnerPlayerId: 'debug-red',
      loserPlayerId: 'debug-blue',
    })
    expect(record).toMatchObject({
      format: 'rvb-match-trace/v2',
      summary: { commandCount: 1 },
      frames: [expect.objectContaining({
        index: 0,
        traceIndex: 1,
        actionType: 'surrender',
        postState: expect.objectContaining({ terminalResult: expect.any(Object) }),
      })],
    })
    expect(record.frames[0]).not.toHaveProperty('preState')
    expect(() => tools.assertTraceRecord(toPlainObject(record))).not.toThrow()
  })


  it('keeps a multi-command Trace compact while preserving skills and materialized states', async () => {
    const tools = loadTraceTools()
    const duel = await createDebugDuel({ seed: 20260822, beginPhase: false })
    let state = runBattleAction(duel.state, {
      type: 'beginPhase',
      clientActionId: 'compact-begin-red',
    } as any).state
    state = runBattleAction(state, {
      type: 'endTurn',
      playerId: 'debug-red',
      clientActionId: 'compact-end-red',
    } as any).state
    state = runBattleAction(state, {
      type: 'beginPhase',
      clientActionId: 'compact-begin-blue',
    } as any).state
    state = runBattleAction(state, {
      type: 'surrender',
      playerId: 'debug-blue',
      reason: 'voluntary',
      clientActionId: 'compact-surrender-blue',
    } as any).state

    const replay = (state.extensions as any).debugBattle.replay
    expect(replay.frames).toHaveLength(4)
    expect(replay.frames.every((frame: any) => (
      frame.inheritsMap === true && !Object.hasOwn(frame.postState, 'map')
    ))).toBe(true)

    const record = tools.createTraceRecord({
      state: toPublicBattleState(state),
      roomId: 'compact-runner-integration',
      seed: 20260822,
    })
    expect(record.content.skills.length).toBeGreaterThan(0)
    expect(record.content.skills).toContainEqual(expect.objectContaining({
      skillId: 'watcher-form',
      name: expect.stringMatching(/形态|form/i),
      cooldownTurns: expect.any(Number),
    }))

    const finalState = tools.materializeTraceState(record, record.frames.length)
    expect(finalState).toMatchObject({
      map: expect.objectContaining({ tiles: expect.any(Array) }),
      terminalResult: expect.objectContaining({ reason: 'surrender' }),
    })
    const watcher = finalState.pieces.find((piece: any) => piece.templateId === 'blue-watcher')
    expect(watcher.skills).toContainEqual(expect.objectContaining({
      skillId: 'watcher-ultimate',
      currentCooldown: 0,
      usesRemaining: 1,
    }))
    expect(Buffer.byteLength(tools.serializeTrace(record), 'utf8')).toBeLessThan(160_000)
  })

  it('rejects legacy, corrupt and dangerous imports without replacing the recent trace', async () => {
    const tools = loadTraceTools()
    const valid = tools.createTraceRecord({
      state: toPublicBattleState(tracedState(true)),
      roomId: 'safe-room',
      exportedAt: '2026-08-21T12:00:00.000Z',
    })
    await tools.storeCompletedTrace(valid)

    expect(() => tools.assertTraceRecord({ format: 'rvb-match-trace/v1', final: {} }))
      .toThrow(/v1.*(?:无法|cannot).*回放|legacy.*replay/i)
    expect(() => tools.assertTraceRecord({ format: 'rvb-match-trace/v99' }))
      .toThrow(/unsupported|version/i)
    expect(() => tools.parseTraceText('{ damaged json'))
      .toThrow(/damaged|invalid/i)

    const missingCheckpoint = toPlainObject(valid)
    delete missingCheckpoint.frames[0].postState
    expect(() => tools.assertTraceRecord(missingCheckpoint)).toThrow(/postState/i)

    const corrupt = toPlainObject(valid)
    corrupt.frames[0].postState.turn.turnNumber = 999
    expect(() => tools.assertTraceRecord(corrupt)).toThrow(/hash/i)

    const ambiguousMap = toPlainObject(valid)
    ambiguousMap.frames[0].inheritsMap = true
    expect(() => tools.assertTraceRecord(ambiguousMap)).toThrow(/inherit.*map|map.*inherit/i)

    const missingMap = toPlainObject(valid)
    delete missingMap.frames[0].postState.map
    expect(() => tools.assertTraceRecord(missingMap)).toThrow(/map/i)

    const dangerous = toPlainObject(valid)
    dangerous.content = { pieces: [], skills: [], portraitUrl: 'javascript:alert(1)' }
    expect(() => tools.assertTraceRecord(dangerous)).toThrow(/dangerous|危险|url/i)

    const sensitive = toPlainObject(valid)
    sensitive.content.privateToken = 'must-not-be-accepted'
    expect(() => tools.assertTraceRecord(sensitive)).toThrow(/sensitive|token/i)

    const tooDeep = toPlainObject(valid)
    let cursor = tooDeep.content
    for (let index = 0; index < 60; index += 1) {
      cursor.extra = {}
      cursor = cursor.extra
    }
    expect(() => tools.assertTraceRecord(tooDeep)).toThrow(/depth|nesting/i)

    await expect(tools.importTraceFile({
      size: tools.MAX_TRACE_BYTES + 1,
      text: async () => JSON.stringify(valid),
    })).rejects.toThrow(/size|MiB/i)

    expect(toPlainObject(await tools.readStoredTrace())).toEqual(toPlainObject(valid))
  })
})

function toPlainObject(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}
