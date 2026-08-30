import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('RED-109 authority transport rollback contract', () => {
  it('broadcasts v3 transitions normally and full snapshots when the coordinator uses the legacy fallback', () => {
    const ws = readFileSync(resolve(process.cwd(), 'lib/ws-server.ts'), 'utf8')
    const handler = ws.slice(
      ws.indexOf("msg.type === 'action' || msg.type === 'gameOver'"),
      ws.indexOf('async function runBotTurn'),
    )

    expect(handler).toContain('if (result.transition)')
    expect(handler).toContain('broadcastBattleTransition(_roomId, result)')
    expect(handler).toContain("result.kind === 'applied' || result.kind === 'expired'")
    expect(handler).toContain('broadcastBattleSnapshot(_roomId, result.snapshot)')
  })

  it('returns and broadcasts the legacy full snapshot from the HTTP command endpoint', () => {
    const http = readFileSync(
      resolve(process.cwd(), 'app/api/rooms/[roomId]/battle/route.ts'),
      'utf8',
    )
    const post = http.slice(http.indexOf('export async function POST'))

    expect(post).toContain("broadcastToRoom(roomId, { type: 'stateUpdate', ...result.snapshot })")
    expect(post).toContain('...(!transition ? result.snapshot : {})')
    expect(post).toContain("...(!transition ? { snapshot: result.snapshot } : {})")
    expect(post).toContain('body.protocolVersion ?? BATTLE_AUTHORITY_PROTOCOL_VERSION')
    expect(post).toContain('body.authorityBuildId ?? BATTLE_AUTHORITY_BUILD_ID')
  })
})
