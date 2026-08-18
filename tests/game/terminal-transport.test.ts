import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CLIENT_TERMINAL_FORBIDDEN,
  getClientTerminalSubmissionError,
  syncRoomTerminalStatus,
} from '@/lib/server/battle-terminal'

describe('authoritative terminal transport contract', () => {
  it.each([
    { type: 'gameOver', winner: 'player-red' },
    { type: 'action', winner: 'player-blue', action: { type: 'endTurn' } },
    { type: 'action', action: { type: 'endTurn', winner: 'player-blue' } },
    { type: 'action', action: { type: 'gameOver' } },
  ])('rejects client-authored terminal fields without room mutation', message => {
    const room = { status: 'playing' }

    expect(getClientTerminalSubmissionError(message)).toEqual({
      code: CLIENT_TERMINAL_FORBIDDEN,
      message: 'Client-authored battle terminal results are forbidden',
    })
    expect(room).toEqual({ status: 'playing' })
  })

  it('marks a room finished only from authoritative battle state', () => {
    const room = { status: 'playing' }

    expect(syncRoomTerminalStatus(room, {})).toBe(false)
    expect(syncRoomTerminalStatus(room, {
      terminalResult: { status: 'finished', winnerPlayerId: null, loserPlayerId: null, reason: 'round-limit' },
    })).toBe(true)
    expect(room.status).toBe('finished')
  })

  it('guards forged results before the shared dispatcher and commits terminal room status in the same CAS', () => {
    const http = readFileSync(resolve(process.cwd(), 'app/api/rooms/[roomId]/battle/route.ts'), 'utf8')
    const ws = readFileSync(resolve(process.cwd(), 'lib/ws-server.ts'), 'utf8')
    const coordinator = readFileSync(resolve(process.cwd(), 'lib/game/room-battle-actions.ts'), 'utf8')
    const httpPost = http.slice(http.indexOf('export async function POST'))
    const wsActionHandler = ws.slice(ws.indexOf("msg.type === 'action' || msg.type === 'gameOver'"))

    for (const source of [httpPost, wsActionHandler]) {
      expect(source.indexOf('getClientTerminalSubmissionError')).toBeLessThan(source.indexOf('dispatchRoomBattleAction'))
    }
    const dispatch = coordinator.slice(coordinator.indexOf('export async function dispatchRoomBattleAction'))
    expect(dispatch).toContain("const isTerminal = actionResult.state.terminalResult?.status === 'finished'")
    expect(dispatch.indexOf("status: 'finished' as const")).toBeLessThan(dispatch.indexOf('if (!await store.setRoomIfVersion'))
    expect(httpPost).not.toContain('roomStore.setRoom(')
    expect(wsActionHandler).not.toContain('roomStore.setRoom(')
    expect(httpPost).not.toContain("body.type === 'gameOver'")
    expect(wsActionHandler).not.toContain('winner: msg.winner')
  })

  it('persists bot terminal state through the same authoritative CAS boundary', () => {
    const ws = readFileSync(resolve(process.cwd(), 'lib/ws-server.ts'), 'utf8')
    const botTurn = ws.slice(ws.indexOf('async function runBotTurn'), ws.indexOf('export function broadcastToRoom'))

    expect(botTurn).toContain('persistAuthoritativeBattleState({ roomId, room, storage })')
    expect(botTurn).toContain('isBattleStateConflict(error)')
  })
})
