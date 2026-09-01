import { describe, expect, it } from 'vitest'

import { createColyseusRejectedReceipt } from '@/lib/server/colyseus/battle-room-protocol'

describe('RED-161 Colyseus rejection protocol', () => {
  it('preserves target-selection continuation data instead of flattening it into a generic failure', () => {
    const action = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'piece-1',
      skillId: 'skill-1',
      clientActionId: 'target-step-1',
    }
    const preparation = {
      kind: 'needTarget' as const,
      selectionId: 'selection-1',
      stateRevision: 7,
      step: 0,
      targetType: 'piece' as const,
      range: 4,
      filter: 'enemy' as const,
      canCancel: true,
      diagnostics: [],
    }
    const failure = Object.assign(new Error('Target selection is required'), {
      code: 'TARGET_SELECTION_REQUIRED',
      receipt: { clientActionId: 'target-step-1', status: 'rejected' },
      preparation,
      needsTargetSelection: true as const,
      targetType: 'piece' as const,
      range: 4,
      filter: 'enemy' as const,
      targetIndex: 0,
    })

    expect(createColyseusRejectedReceipt({
      failure,
      clientActionId: 'target-step-1',
      action,
      authorityVersion: 7,
      durableAuthorityVersion: 6,
    })).toMatchObject({
      kind: 'rejected',
      code: 'TARGET_SELECTION_REQUIRED',
      error: 'Target selection is required',
      action,
      receipt: { clientActionId: 'target-step-1', status: 'rejected' },
      preparation,
      needsTargetSelection: true,
      targetType: 'piece',
      range: 4,
      filter: 'enemy',
      targetIndex: 0,
      authorityVersion: 7,
      durableAuthorityVersion: 6,
    })
  })
})
