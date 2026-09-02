import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planBotActions, prepareLegalBotAction } from '@/lib/game/ai'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { runBattleAction } from '@/lib/game/battle-runner'
import type { PieceTemplate } from '@/lib/game/piece'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import type { BattleAction, BattleState } from '@/lib/game/turn'

describe('RED-109 authority transport rollback contract', () => {
  it('broadcasts v3 transitions normally and rebuilds fallback snapshots for each recipient', () => {
    const ws = readFileSync(resolve(process.cwd(), 'lib/ws-server.ts'), 'utf8')
    const handler = ws.slice(
      ws.indexOf("msg.type === 'action' || msg.type === 'gameOver'"),
      ws.indexOf('async function runBotTurn'),
    )

    expect(handler).toContain('if (result.transition)')
    expect(handler).toContain('broadcastBattleTransition(_roomId, result)')
    expect(handler).toContain("result.kind === 'applied' || result.kind === 'expired'")
    expect(handler).toMatch(/await broadcastBattleSnapshot\(_roomId,\s*\{\s*snapshot: result\.snapshot,\s*state: result\.actionResult\.state,\s*\}\)/)
    expect(handler).not.toContain("broadcastToRoom(_roomId, { type: 'stateUpdate', ...result.snapshot })")

    const expiredBranch = handler.slice(handler.indexOf("if (result.kind === 'expired')"))
    const expiredReturn = /\r?\n\s+return\r?\n/.exec(expiredBranch)
    expect(expiredReturn).not.toBeNull()
    expect(expiredBranch.indexOf('queueBotTurnIfReady(_roomId, result.actionResult.state)'))
      .toBeLessThan(expiredReturn!.index)
  })

  it('returns the legacy fallback only to the requester and rebuilds broadcasts for each recipient', () => {
    const http = readFileSync(
      resolve(process.cwd(), 'app/api/rooms/[roomId]/battle/route.ts'),
      'utf8',
    )
    const post = http.slice(http.indexOf('export async function POST'))

    expect(post).toMatch(/await broadcastBattleSnapshot\(roomId,\s*\{\s*snapshot: result\.snapshot,\s*state: result\.actionResult\.state,\s*\}\)/)
    expect(post).not.toContain("broadcastToRoom(roomId, { type: 'stateUpdate', ...result.snapshot })")
    expect(post).toContain('...(!transition ? result.snapshot : {})')
    expect(post).toContain("...(!transition ? { snapshot: result.snapshot } : {})")
    expect(post).toContain('body.protocolVersion ?? BATTLE_AUTHORITY_PROTOCOL_VERSION')
    expect(post).toContain('body.authorityBuildId ?? BATTLE_AUTHORITY_BUILD_ID')
    expect(post).toMatch(/onBotTurnReady:\s*\(_snapshot, authorityState\)\s*=>\s*\{\s*void queueBotTurnIfReady\(roomId, authorityState\)/)
  })

  it('does not overwrite roster-start projections with viewer-less battle snapshots', () => {
    const ws = readFileSync(resolve(process.cwd(), 'lib/ws-server.ts'), 'utf8')
    const roomActions = ws.slice(
      ws.indexOf('async function applyRoomAction'),
      ws.indexOf('function sendJson'),
    )

    expect(roomActions.match(/startBattleWithDeploymentBroadcast\(roomId\)/g)).toHaveLength(2)
    expect(roomActions).not.toContain('sendBattleSnapshot(client, roomId)')
  })
})

describe('RED-138 deterministic progressive bot decisions', () => {
  const players = ['human', 'bot'] as const
  const rootSeed = 0x138b07

  function inertRoster(prefix: 'human' | 'bot'): PieceTemplate[] {
    return Array.from({ length: 8 }, (_, index) => ({
      id: `${prefix}-piece-${index + 1}`,
      name: `${prefix} piece ${index + 1}`,
      faction: prefix === 'human' ? 'good' : 'evil',
      rarity: 'common',
      stats: { maxHp: 100, attack: 0, defense: 0, moveRange: 0 },
      skills: [],
    }))
  }

  it('submits only legal decisions across three bot turns and deploys at most once per turn', async () => {
    const humanRoster = inertRoster('human')
    const botRoster = inertRoster('bot')
    const initial = await createInitialBattleForPlayers(
      [...players],
      [...humanRoster, ...botRoster],
      [
        { playerId: players[0], pieces: humanRoster, faction: 'red', alignment: 'light' },
        { playerId: players[1], pieces: botRoster, faction: 'blue', alignment: 'dark' },
      ],
      'large-hole-arena',
      {
        firstPlayerId: players[0],
        rootSeed,
        deploymentEnabled: true,
        deploymentMode: 'progressive-reserve-v1',
        deploymentStartedAt: 1_750_000_000_000,
      },
    )
    if (!initial) throw new Error('Expected progressive bot fixture')

    let state = initial
    let actionBatch: { key: string; actions: BattleAction[] } | undefined
    let completedBotTurns = 0
    const botDeploymentsByTurn = new Map<number, number>()
    const submittedActionTypes: string[] = []

    for (let guard = 0; guard < 128 && completedBotTurns < 3; guard += 1) {
      const owner = getCurrentInputOwnerPlayerId(state)
      const hasPending = !!(state.pendingOptionSelection || state.pendingTargetSelection)
      const actionKey = owner.toLowerCase() + ':' + String(state.turn.turnNumber)
      const usesActionBatch = state.turn.phase === 'action' && !hasPending
      let draft: BattleAction | undefined

      if (usesActionBatch) {
        if (actionBatch?.key !== actionKey) {
          const plan = planBotActions(state, owner)
          expect(plan?.kind).toBe('action')
          actionBatch = { key: actionKey, actions: [...(plan?.actions ?? [])] }
        }
        draft = actionBatch.actions.shift()
      } else {
        const plan = planBotActions(state, owner)
        expect(plan?.kind).toBe('structural')
        expect(plan?.actions).toHaveLength(1)
        draft = plan?.actions[0]
      }

      expect(draft).toBeDefined()
      const legalAction = prepareLegalBotAction(state, draft!, owner)
      expect(legalAction).toBeDefined()
      submittedActionTypes.push(legalAction!.type)

      if (owner === 'bot' && legalAction?.type === 'deployReservePiece') {
        botDeploymentsByTurn.set(
          state.turn.turnNumber,
          (botDeploymentsByTurn.get(state.turn.turnNumber) ?? 0) + 1,
        )
      }
      if (owner === 'bot' && legalAction?.type === 'endTurn') completedBotTurns += 1

      state = runBattleAction(state, legalAction!, { rootSeed }).state as BattleState
      if (legalAction?.type === 'deployReservePiece' && !state.pendingOptionSelection && !state.pendingTargetSelection) {
        expect(state.turn.phase).toBe('action')
        expect(state.deployment?.status).not.toBe('awaiting-free-move')
      }
    }

    expect(completedBotTurns).toBe(3)
    expect([...botDeploymentsByTurn.values()]).toEqual([1, 1, 1])
    expect(Math.max(...botDeploymentsByTurn.values())).toBeLessThanOrEqual(1)
    expect(submittedActionTypes).not.toContain('deploymentFreeMove')
    expect(submittedActionTypes).not.toContain('deploymentSkipFreeMove')
  })
})
