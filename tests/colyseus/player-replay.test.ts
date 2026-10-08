import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { hashBattleState, hashStable } from '@/lib/game/battle-runner'
import {
  OfficialReplayService,
} from '@/lib/server/official/player-replay'
import type { BattleAuthorityCheckpointRecord } from '@/lib/game/battle-transition'
import type { BattleState } from '@/lib/game/turn'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import type { PostgresBattleReportV1 } from '@/lib/server/postgres/authority-types'
import { makeState } from '../helpers/minimal-state'
import { pinTestBattleState } from '../game/profile-test-identity'

type ReplayPool = ConstructorParameters<typeof OfficialReplayService>[0]
type ReplayReports = ConstructorParameters<typeof OfficialReplayService>[1]
type BrowserTraceTools = { assertTraceRecord: (value: unknown) => unknown }

function completedState(): { state: BattleState; authorityHash: string; checkpointHash: string } {
  const state = makeState({
    turnNumber: 3,
    pieces: [{ instanceId: 'piece-red-1', ownerPlayerId: 'player-red', currentHp: 100 }],
  })
  Object.assign(state.pieces[0], {
    templateId: 'blue-naruto',
    name: '漩涡鸣人',
    faction: 'blue',
  })
  state.terminalResult = {
    status: 'finished',
    winnerPlayerId: 'player-red',
    loserPlayerId: 'player-blue',
    reason: 'surrender',
    settledAt: {
      actionIndex: 0,
      actionType: 'surrender',
      actorPlayerId: 'player-blue',
      turnNumber: 3,
      phase: 'action',
      completedRound: 2,
    },
  } as BattleState['terminalResult']

  const checkpoint = JSON.parse(JSON.stringify(state))
  delete checkpoint.extensions
  const authorityHash = hashBattleState(checkpoint)
  const checkpointHash = hashStable(checkpoint)
  state.extensions = {
    debugBattle: {
      appliedActionIds: ['private-action-id'],
      actionLog: [{
        index: 0,
        rootSeed: 9876,
        actionId: 'action-1',
        actionHash: authorityHash,
        tick: 0,
        turn: 3,
        playerId: 'player-red',
        preStateHash: authorityHash,
        postStateHash: authorityHash,
        randomStreams: [],
      }],
      commandLog: [{
        type: 'surrender',
        authorization: { token: 'private-token' },
        signature: 'private-signature',
      }],
      replay: {
        format: 'rvb-battle-replay/v2',
        initialStateHash: authorityHash,
        initialCheckpointHash: checkpointHash,
        initialState: checkpoint,
        frames: [{
          index: 0,
          traceIndex: 0,
          action: { type: 'surrender' },
          actionType: 'surrender',
          playerId: 'player-blue',
          turnBefore: 3,
          turnAfter: 3,
          phaseBefore: 'action',
          phaseAfter: 'action',
          preStateHash: authorityHash,
          postStateHash: authorityHash,
          preCheckpointHash: checkpointHash,
          postCheckpointHash: checkpointHash,
          postState: checkpoint,
          events: [{ type: 'match-finished' }],
          randomStreams: [],
        }],
      },
    },
  }
  pinTestBattleState(state as unknown as Record<string, unknown>, 9876)
  return { state, authorityHash, checkpointHash }
}

function reportFor(state: ReturnType<typeof completedState>): PostgresBattleReportV1 {
  const checkpoint: BattleAuthorityCheckpointRecord = {
    protocolVersion: 3,
    roomId: 'match-1',
    authorityVersion: 12,
    seed: 9876,
    stateHash: state.authorityHash,
    publicHash: 'b'.repeat(64),
    transitionHash: 'c'.repeat(64),
    reason: 'terminal',
    createdAt: Date.parse('2026-10-08T00:00:00.000Z'),
    storage: {
      type: 'server-state',
      storageSchemaVersion: 'rvb-server-battle-state/v1',
      profileIdentity: getServerGameProfileIdentityV1(),
      rootSeed: 9876,
      state: state.state,
    },
  }
  const report: PostgresBattleReportV1 = {
    schemaVersion: 'rvb-postgres-battle-report/v1',
    verified: true,
    battleId: 'match-1',
    room: {
      id: 'match-1',
      name: '测试对局',
      mapId: 'test-map',
      players: [
        { id: 'player-red', accountId: 'account-red', name: '红方', seat: 'red', alignment: 'light' },
        { id: 'player-blue', accountId: 'account-blue', name: '蓝方', seat: 'blue', alignment: 'dark' },
      ],
    },
    authority: {
      authorityVersion: 12,
      durableAuthorityVersion: 12,
      stateHash: state.authorityHash,
      publicHash: 'b'.repeat(64),
      transitionHash: 'c'.repeat(64),
    },
    terminal: {
      committedAt: '2026-10-08T00:00:00.000Z',
      checkpoint,
    },
    receipts: [],
    transitions: [],
  }
  // The exporter must never copy either of these collections into its public
  // record. Their values intentionally resemble bearer material.
  report.receipts = [{ authorization: 'private-receipt', signature: 'private-receipt-signature' }] as unknown as PostgresBattleReportV1['receipts']
  report.transitions = [{ receipt: { token: 'private-transition-token' } }] as unknown as PostgresBattleReportV1['transitions']
  return report
}

function loadBrowserTraceTools(): BrowserTraceTools {
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/developer-tools/match-trace.js'),
    'utf8',
  )
  const context = createContext({
    window: {},
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
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
  const browserWindow = context as unknown as { window: { RvBDeveloperTools: BrowserTraceTools } }
  return browserWindow.window.RvBDeveloperTools
}

function fakePool(status: string, firstId = 'player-red', secondId = 'player-blue', barrier = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM official_matches')) {
      return { rows: [{ status, first_id: firstId, second_id: secondId }] }
    }
    return { rows: barrier ? [{ authority_version: 12 }] : [] }
  })
  return { query }
}

function serviceFor(pool: ReturnType<typeof fakePool>, reports: { readBattleReport: unknown }): OfficialReplayService {
  return new OfficialReplayService(pool as unknown as ReplayPool, reports as unknown as ReplayReports)
}

describe('official player replay export', () => {
  it('exports a real Trace v2 archive accepted by the browser validator without report internals', async () => {
    const state = completedState()
    const report = reportFor(state)
    const reports = { readBattleReport: vi.fn(async () => report) }
    const pool = fakePool('settled')

    const trace = await serviceFor(pool, reports).read('player-red', 'match-1')
    loadBrowserTraceTools().assertTraceRecord(trace)

    expect(trace).toMatchObject({
      format: 'rvb-match-trace/v2',
      roomId: 'match-1',
      seed: 9876,
      authorityVersion: 12,
      source: {
        kind: 'official-match',
        map: { id: 'test-map', name: 'Test Map' },
      },
      final: { reason: 'surrender', winnerPlayerId: 'player-red' },
    })
    expect(trace.source?.players).toEqual([
      { playerId: 'player-red', name: '红方', seat: 'red', alignment: 'light' },
      { playerId: 'player-blue', name: '蓝方', seat: 'blue', alignment: 'dark' },
    ])
    expect(trace.content.pieces.find(piece => piece.templateId === 'blue-naruto')?.imageId).toBe('naruto.jpg')
    expect(JSON.stringify(trace)).not.toContain('private-receipt')
    expect(JSON.stringify(trace)).not.toContain('private-token')
    expect(JSON.stringify(trace)).not.toContain('accountId')
    expect(reports.readBattleReport).toHaveBeenCalledTimes(1)
    expect(pool.query).toHaveBeenCalledTimes(2)
  })

  it('checks participant, settled status, and the terminal barrier before reading the heavy report', async () => {
    const state = completedState()
    const reports = { readBattleReport: vi.fn(async () => reportFor(state)) }

    const outsiderPool = fakePool('settled', 'player-red', 'player-blue')
    await expect(serviceFor(outsiderPool, reports).read('outsider', 'match-1'))
      .rejects.toMatchObject({ status: 403 })
    expect(reports.readBattleReport).not.toHaveBeenCalled()
    expect(outsiderPool.query).toHaveBeenCalledTimes(1)

    const pendingReports = { readBattleReport: vi.fn(async () => reportFor(state)) }
    const pendingPool = fakePool('assigned')
    await expect(serviceFor(pendingPool, pendingReports).read('player-red', 'match-1'))
      .rejects.toMatchObject({ status: 409 })
    expect(pendingReports.readBattleReport).not.toHaveBeenCalled()
    expect(pendingPool.query).toHaveBeenCalledTimes(1)

    const missingBarrierReports = { readBattleReport: vi.fn(async () => reportFor(state)) }
    const missingBarrierPool = fakePool('settled', 'player-red', 'player-blue', false)
    await expect(serviceFor(missingBarrierPool, missingBarrierReports).read('player-red', 'match-1'))
      .rejects.toMatchObject({ status: 404 })
    expect(missingBarrierReports.readBattleReport).not.toHaveBeenCalled()
    expect(missingBarrierPool.query).toHaveBeenCalledTimes(2)
  })

  it('marks a missing or malformed v2 archive unavailable without leaking checkpoint details', async () => {
    const state = completedState()
    const metadata = state.state.extensions?.debugBattle
    if (metadata) delete metadata.replay
    const reports = { readBattleReport: vi.fn(async () => reportFor(state)) }
    const pool = fakePool('settled')

    await expect(serviceFor(pool, reports).read('player-red', 'match-1'))
      .rejects.toMatchObject({ status: 404 })
    await expect(serviceFor(pool, reports).read('player-red', 'match-1'))
      .rejects.toMatchObject({
        status: 404,
        message: expect.not.stringMatching(/private|checkpoint|receipt|signature/i),
      })
  })
})
