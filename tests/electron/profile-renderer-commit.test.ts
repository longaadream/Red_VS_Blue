import { describe, expect, test, vi } from 'vitest'

import {
  reconcileProfileRendererCommit,
  recoverUncertainProfileCommit,
} from '../../electron-client/resource-pack-store'

describe('RED-115 committed Profile renderer reconciliation', () => {
  test('restarts and re-observes when commit succeeded but response and first process were lost', async () => {
    const targetProfileHash = 'c'.repeat(64)
    const observe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        state: { stable: { resolvedProfileHash: targetProfileHash } },
        server: {
          healthy: true,
          activationId: null,
          profile: { resolvedProfileHash: targetProfileHash },
        },
      })
    const restartStable = vi.fn().mockResolvedValue(undefined)

    await expect(recoverUncertainProfileCommit(
      targetProfileHash,
      observe,
      restartStable,
    )).resolves.toMatchObject({
      state: { stable: { resolvedProfileHash: targetProfileHash } },
    })
    expect(restartStable).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledTimes(2)
  })

  test('does not accept a committed hash until recovery clears the activation gate', async () => {
    const targetProfileHash = 'd'.repeat(64)
    const stillPaused = {
      state: { stable: { resolvedProfileHash: targetProfileHash } },
      server: {
        healthy: true,
        activationId: 'stale-activation',
        profile: { resolvedProfileHash: targetProfileHash },
      },
    }
    const restartStable = vi.fn().mockResolvedValue(undefined)

    await expect(recoverUncertainProfileCommit(
      targetProfileHash,
      vi.fn().mockResolvedValue(stillPaused),
      restartStable,
    )).resolves.toBeNull()
    expect(restartStable).toHaveBeenCalledOnce()
  })

  test('reports recovered commit success only after renderer identity and health verification', async () => {
    const reloadAndVerify = vi.fn().mockResolvedValue(undefined)
    const releaseAdmission = vi.fn().mockResolvedValue(undefined)
    const rollbackPreviousStable = vi.fn()
    const recordFailureEvidence = vi.fn()
    const recordRollbackEvidence = vi.fn()
    const enterFailClosed = vi.fn()

    await expect(reconcileProfileRendererCommit({
      expectedProfileHash: 'b'.repeat(64),
      stage: 'renderer-commit-recovery-reload',
      success: { commitRecovered: true, state: { revision: 4 } },
      allowRollback: true,
      reloadAndVerify,
      releaseAdmission,
      rollbackPreviousStable,
      recordFailureEvidence,
      recordRollbackEvidence,
      enterFailClosed,
    })).resolves.toMatchObject({
      ok: true,
      commitRecovered: true,
      state: { revision: 4 },
    })
    expect(reloadAndVerify).toHaveBeenCalledWith('b'.repeat(64))
    expect(releaseAdmission).toHaveBeenCalledWith('b'.repeat(64))
    expect(reloadAndVerify.mock.invocationCallOrder[0])
      .toBeLessThan(releaseAdmission.mock.invocationCallOrder[0])
    expect(rollbackPreviousStable).not.toHaveBeenCalled()
    expect(recordFailureEvidence).not.toHaveBeenCalled()
    expect(recordRollbackEvidence).not.toHaveBeenCalled()
    expect(enterFailClosed).not.toHaveBeenCalled()
  })

  test('rolls back previous stable when recovered commit renderer verification fails', async () => {
    const rollbackPreviousStable = vi.fn().mockResolvedValue({
      ok: true,
      alreadyActive: false,
    })
    const recordFailureEvidence = vi.fn().mockResolvedValue(undefined)
    const recordRollbackEvidence = vi.fn().mockResolvedValue(undefined)
    const enterFailClosed = vi.fn()

    await expect(reconcileProfileRendererCommit({
      expectedProfileHash: 'b'.repeat(64),
      stage: 'renderer-commit-recovery-reload',
      success: { commitRecovered: true },
      allowRollback: true,
      reloadAndVerify: vi.fn().mockRejectedValue(new Error('renderer hash mismatch')),
      releaseAdmission: vi.fn(),
      rollbackPreviousStable,
      recordFailureEvidence,
      recordRollbackEvidence,
      enterFailClosed,
    })).resolves.toMatchObject({
      ok: false,
      code: 'PROFILE_RENDERER_RELOAD_FAILED',
      stage: 'renderer-commit-recovery-reload',
      rolledBack: true,
      rollback: { ok: true },
    })
    expect(rollbackPreviousStable).toHaveBeenCalledOnce()
    expect(recordFailureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROFILE_RENDERER_RELOAD_FAILED',
      targetProfileHash: 'b'.repeat(64),
    }))
    expect(recordRollbackEvidence).toHaveBeenCalledWith(expect.objectContaining({
      rollbackSucceeded: true,
    }))
    expect(enterFailClosed).not.toHaveBeenCalled()
  })

  test('does not recurse when renderer verification fails during rollback activation', async () => {
    const rollbackPreviousStable = vi.fn()
    const recordFailureEvidence = vi.fn().mockResolvedValue(undefined)
    const recordRollbackEvidence = vi.fn()
    const enterFailClosed = vi.fn().mockResolvedValue(undefined)

    await expect(reconcileProfileRendererCommit({
      expectedProfileHash: 'a'.repeat(64),
      stage: 'renderer-commit-reload',
      success: { state: { revision: 5 } },
      allowRollback: false,
      reloadAndVerify: vi.fn().mockRejectedValue(new Error('renderer unavailable')),
      releaseAdmission: vi.fn(),
      rollbackPreviousStable,
      recordFailureEvidence,
      recordRollbackEvidence,
      enterFailClosed,
    })).resolves.toMatchObject({
      ok: false,
      code: 'PROFILE_RENDERER_RELOAD_FAILED',
      requiresApplicationRestart: true,
      admissionPaused: true,
      state: { revision: 5 },
    })
    expect(rollbackPreviousStable).not.toHaveBeenCalled()
    expect(recordFailureEvidence).toHaveBeenCalledOnce()
    expect(recordFailureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      rollbackTarget: null,
    }))
    expect(recordRollbackEvidence).not.toHaveBeenCalled()
    expect(enterFailClosed).toHaveBeenCalledOnce()
  })

  test('fails closed when renderer rollback returns a failure result', async () => {
    const enterFailClosed = vi.fn().mockResolvedValue(undefined)
    const releaseAdmission = vi.fn()

    await expect(reconcileProfileRendererCommit({
      expectedProfileHash: 'e'.repeat(64),
      stage: 'renderer-commit-reload',
      success: { state: { revision: 6 } },
      allowRollback: true,
      reloadAndVerify: vi.fn().mockRejectedValue(new Error('renderer hash mismatch')),
      releaseAdmission,
      rollbackPreviousStable: vi.fn().mockResolvedValue({
        ok: false,
        error: 'rollback renderer failed',
      }),
      recordFailureEvidence: vi.fn().mockResolvedValue(undefined),
      recordRollbackEvidence: vi.fn().mockResolvedValue(undefined),
      enterFailClosed,
    })).resolves.toMatchObject({
      ok: false,
      rolledBack: false,
      requiresApplicationRestart: true,
      admissionPaused: true,
      rollback: { ok: false },
    })
    expect(releaseAdmission).not.toHaveBeenCalled()
    expect(enterFailClosed).toHaveBeenCalledOnce()
  })

  test('fails closed when renderer rollback throws', async () => {
    const enterFailClosed = vi.fn().mockResolvedValue(undefined)

    await expect(reconcileProfileRendererCommit({
      expectedProfileHash: 'f'.repeat(64),
      stage: 'renderer-commit-reload',
      success: { state: { revision: 7 } },
      allowRollback: true,
      reloadAndVerify: vi.fn().mockRejectedValue(new Error('renderer hash mismatch')),
      releaseAdmission: vi.fn(),
      rollbackPreviousStable: vi.fn().mockRejectedValue(new Error('rollback unavailable')),
      recordFailureEvidence: vi.fn().mockResolvedValue(undefined),
      recordRollbackEvidence: vi.fn().mockResolvedValue(undefined),
      enterFailClosed,
    })).resolves.toMatchObject({
      ok: false,
      rolledBack: false,
      requiresApplicationRestart: true,
      admissionPaused: true,
      rollback: { ok: false, error: 'rollback unavailable' },
    })
    expect(enterFailClosed).toHaveBeenCalledOnce()
  })

  test('rolls back without reopening admission when release fails after renderer verification', async () => {
    const releaseAdmission = vi.fn().mockRejectedValue(new Error('release rejected'))
    const rollbackPreviousStable = vi.fn().mockResolvedValue({ ok: true })

    await expect(reconcileProfileRendererCommit({
      expectedProfileHash: '1'.repeat(64),
      stage: 'renderer-commit-reload',
      success: { state: { revision: 8 } },
      allowRollback: true,
      reloadAndVerify: vi.fn().mockResolvedValue(undefined),
      releaseAdmission,
      rollbackPreviousStable,
      recordFailureEvidence: vi.fn().mockResolvedValue(undefined),
      recordRollbackEvidence: vi.fn().mockResolvedValue(undefined),
      enterFailClosed: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      rolledBack: true,
    })
    expect(releaseAdmission).toHaveBeenCalledOnce()
    expect(rollbackPreviousStable).toHaveBeenCalledOnce()
  })
})
