import { afterEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/db'
import type { Room } from '@/lib/game/room-store'
import { restoreBattleAuthorityRoom } from '@/lib/server/battle-authority-persistence'

const originalAuthorityV2Flag = process.env.RVB_BATTLE_AUTHORITY_V2

afterEach(() => {
  if (originalAuthorityV2Flag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
  else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthorityV2Flag
  vi.restoreAllMocks()
})

describe('RED-127 legacy room restore boundary', () => {
  it('does not query V2 checkpoints for a waiting room when authority V2 is disabled', async () => {
    process.env.RVB_BATTLE_AUTHORITY_V2 = '0'
    const checkpointQuery = vi.spyOn(prisma.battleAuthorityCheckpoint, 'findFirst')
      .mockRejectedValue(new Error('checkpoint query must not run'))
    const room: Room = {
      id: 'legacy-waiting-room',
      name: 'Legacy waiting room',
      status: 'waiting',
      players: [{ id: 'host', name: 'Host' }],
      spectators: [],
      hostId: 'host',
      currentTurnIndex: 0,
      actions: [],
      version: 1,
    }

    await expect(restoreBattleAuthorityRoom(room)).resolves.toBe(room)
    expect(checkpointQuery).not.toHaveBeenCalled()
  })
})
