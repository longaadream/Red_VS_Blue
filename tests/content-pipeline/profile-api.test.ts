import { afterEach, describe, expect, test, vi } from 'vitest'

const beginProfileActivation = vi.hoisted(() => vi.fn())
const getProfileServerReport = vi.hoisted(() => vi.fn())
const getProfileLeaseReport = vi.hoisted(() => vi.fn())
const readProfileState = vi.hoisted(() => vi.fn())
const commitProfileActivation = vi.hoisted(() => vi.fn())
const recordActivationFailure = vi.hoisted(() => vi.fn())
const recordProfileAuditEvidence = vi.hoisted(() => vi.fn())
const bindStableRuntimeProfile = vi.hoisted(() => vi.fn())
const recoverRuntimeProfileOnStartup = vi.hoisted(() => vi.fn())
const logProfileEvent = vi.hoisted(() => vi.fn())
const reconcileRuntimePveAuthority = vi.hoisted(() => vi.fn())

vi.mock('@/lib/content-pipeline/runtime/profile-runtime', () => ({
  beginProfileActivationV1: beginProfileActivation,
  getProfileRuntimeContextV1: () => ({ store: { readState: readProfileState, commitActivation: commitProfileActivation } }),
  getProfileServerReportV1: getProfileServerReport,
  getProfileLeaseReportV1: getProfileLeaseReport,
  recordActivationFailureV1: recordActivationFailure,
  recordProfileAuditEvidenceV1: recordProfileAuditEvidence,
  bindStableRuntimeProfileV1: bindStableRuntimeProfile,
  recoverRuntimeProfileOnStartupV1: recoverRuntimeProfileOnStartup,
  logProfileEventV1: logProfileEvent,
  reconcileRuntimePveAuthorityV1: reconcileRuntimePveAuthority,
}))

import { POST } from '@/app/api/content-profile/activation/plan/route'
import { POST as POST_FAILURE } from '@/app/api/content-profile/activation/failure/route'
import { POST as POST_RELEASE } from '@/app/api/content-profile/activation/release/route'
import { POST as POST_COMMIT } from '@/app/api/content-profile/activation/commit/route'
import { POST as POST_RECOVERY } from '@/app/api/content-profile/recovery/route'
import { GET } from '@/app/api/content-profile/route'

const originalAdminKey = process.env.RVB_PROFILE_ADMIN_KEY
const originalAdmissionPause = process.env.RVB_PROFILE_ADMISSION_PAUSED

afterEach(() => {
  beginProfileActivation.mockReset()
  getProfileServerReport.mockReset()
  getProfileLeaseReport.mockReset()
  readProfileState.mockReset()
  commitProfileActivation.mockReset()
    recordActivationFailure.mockReset()
    recordProfileAuditEvidence.mockReset()
    bindStableRuntimeProfile.mockReset()
    recoverRuntimeProfileOnStartup.mockReset()
    logProfileEvent.mockReset()
    reconcileRuntimePveAuthority.mockReset()
  if (originalAdminKey === undefined) delete process.env.RVB_PROFILE_ADMIN_KEY
  else process.env.RVB_PROFILE_ADMIN_KEY = originalAdminKey
  if (originalAdmissionPause === undefined) delete process.env.RVB_PROFILE_ADMISSION_PAUSED
  else process.env.RVB_PROFILE_ADMISSION_PAUSED = originalAdmissionPause
})

describe('RED-115 Profile activation API boundary', () => {
  test('commits durably, reconciles PVE authority, then releases admission', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-commit'
    const stable = { resolvedProfileHash: '1'.repeat(64), authorityContentHash: 'a'.repeat(64), compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' }, capabilities: ['game-data'] }
    const candidate = { resolvedProfileHash: '2'.repeat(64), authorityContentHash: 'b'.repeat(64), compatibility: stable.compatibility, capabilities: ['game-data'] }
    const committed = { stable: candidate, previousStable: stable, candidate: null, activation: null }
    readProfileState.mockReturnValueOnce({ stable, candidate, activation: { activationId: 'activation-commit' } })
    getProfileLeaseReport.mockResolvedValueOnce({ active: false, roomIds: [], pveRunIds: [], pveBattleIds: [] })
    getProfileServerReport.mockResolvedValueOnce({ healthy: true, activationId: 'activation-commit', profile: candidate, fixedSeed: { seed: 1, stateHash: 'hash' } })
    commitProfileActivation.mockReturnValueOnce(committed)
    reconcileRuntimePveAuthority.mockResolvedValueOnce({ clearedRunIds: ['old-run'] })

    const response = await POST_COMMIT(new Request('http://localhost/api/content-profile/activation/commit', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-rvb-profile-admin-key': 'test-key' },
      body: JSON.stringify({ activationId: 'activation-commit', targetProfileHash: candidate.resolvedProfileHash }),
    }))

    expect(response.status).toBe(200)
    expect(commitProfileActivation.mock.invocationCallOrder[0]).toBeLessThan(reconcileRuntimePveAuthority.mock.invocationCallOrder[0])
    expect(reconcileRuntimePveAuthority.mock.invocationCallOrder[0]).toBeLessThan(bindStableRuntimeProfile.mock.invocationCallOrder[0])
  })

  test('rejects authority commit on an active PVE lease before health, commit, or cleanup', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-pve-lease'
    const stable = {
      resolvedProfileHash: '4'.repeat(64),
      authorityContentHash: 'd'.repeat(64),
      compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
      capabilities: ['game-data'],
    }
    const candidate = {
      resolvedProfileHash: '5'.repeat(64),
      authorityContentHash: 'e'.repeat(64),
      compatibility: stable.compatibility,
      capabilities: ['game-data'],
    }
    readProfileState.mockReturnValueOnce({
      stable,
      candidate,
      activation: { activationId: 'activation-pve-lease' },
    })
    getProfileLeaseReport.mockResolvedValueOnce({
      active: true,
      roomIds: [],
      pveRunIds: ['pve-run-active'],
      pveBattleIds: ['pve-battle-active'],
    })

    const response = await POST_COMMIT(new Request('http://localhost/api/content-profile/activation/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rvb-profile-admin-key': 'test-key' },
      body: JSON.stringify({
        activationId: 'activation-pve-lease',
        targetProfileHash: candidate.resolvedProfileHash,
      }),
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'PROFILE_IN_USE',
      message: 'PROFILE_IN_USE: pve-run-active,pve-battle-active',
    })
    expect(getProfileServerReport).not.toHaveBeenCalled()
    expect(commitProfileActivation).not.toHaveBeenCalled()
    expect(reconcileRuntimePveAuthority).not.toHaveBeenCalled()
    expect(bindStableRuntimeProfile).not.toHaveBeenCalled()
  })

  test('retries postcommit PVE reconciliation without committing the Profile twice', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    const stable = {
      resolvedProfileHash: '3'.repeat(64),
      authorityContentHash: 'c'.repeat(64),
      compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
      capabilities: ['game-data'],
    }
    readProfileState.mockReturnValueOnce({ stable, candidate: null, activation: null })
    getProfileServerReport.mockResolvedValueOnce({
      healthy: true,
      activationId: null,
      profile: stable,
    })

    const response = await POST_COMMIT(new Request('http://localhost/api/content-profile/activation/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rvb-profile-admin-key': 'test-key' },
      body: JSON.stringify({ activationId: 'activation-retry', targetProfileHash: stable.resolvedProfileHash }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ alreadyCommitted: true })
    expect(commitProfileActivation).not.toHaveBeenCalled()
    expect(reconcileRuntimePveAuthority).toHaveBeenCalledWith(
      stable.authorityContentHash,
      'activation-commit',
    )
    expect(reconcileRuntimePveAuthority.mock.invocationCallOrder[0])
      .toBeLessThan(bindStableRuntimeProfile.mock.invocationCallOrder[0])
  })

  test('requires the per-process Electron admin key', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    const response = await POST(new Request('http://localhost/api/content-profile/activation/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetProfileHash: 'a'.repeat(64) }),
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'UNAUTHORIZED' })
    expect(beginProfileActivation).not.toHaveBeenCalled()
  })

  test('protects the expensive state and health report with the same admin key', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    const unauthorized = await GET(new Request('http://localhost/api/content-profile'))
    expect(unauthorized.status).toBe(401)
    expect(readProfileState).not.toHaveBeenCalled()
    expect(getProfileServerReport).not.toHaveBeenCalled()

    readProfileState.mockReturnValueOnce({ stable: { resolvedProfileHash: 'a'.repeat(64) } })
    getProfileServerReport.mockResolvedValueOnce({ healthy: true })
    const authorized = await GET(new Request('http://localhost/api/content-profile', {
      headers: { 'x-rvb-profile-admin-key': 'test-key' },
    }))
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toMatchObject({ server: { healthy: true } })
  })

  test('returns a stable PROFILE_IN_USE conflict for active gameplay', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    beginProfileActivation.mockRejectedValueOnce(new Error('PROFILE_IN_USE: active-battle'))
    const response = await POST(new Request('http://localhost/api/content-profile/activation/plan', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rvb-profile-admin-key': 'test-key',
      },
      body: JSON.stringify({ targetProfileHash: 'b'.repeat(64) }),
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'PROFILE_IN_USE',
      message: 'PROFILE_IN_USE: active-battle',
    })
  })

  test('keeps admission fail-closed when durable authority drain did not acknowledge', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    recordActivationFailure.mockReturnValueOnce({ stable: { resolvedProfileHash: 'a'.repeat(64) } })
    const response = await POST_FAILURE(new Request('http://localhost/api/content-profile/activation/failure', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rvb-profile-admin-key': 'test-key',
      },
      body: JSON.stringify({
        activationId: 'activation-drain-failed',
        code: 'CANDIDATE_ACTIVATION_FAILED',
        stage: 'candidate-server-start',
        message: 'PROFILE_DURABLE_DRAIN_FAILED',
        keepAdmissionPaused: true,
      }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ admissionPaused: true })
    expect(bindStableRuntimeProfile).not.toHaveBeenCalled()
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBe('activation-drain-failed')
  })

  test('returns a fresh-process requirement when startup recovery changes runtime identity', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    const recoveredAuthority = 'c'.repeat(64)
    recoverRuntimeProfileOnStartup.mockReturnValueOnce({
      state: {
        stable: {
          resolvedProfileHash: 'a'.repeat(64),
          authorityContentHash: recoveredAuthority,
        },
        lastFailure: {},
      },
      requiresProcessRestart: true,
      previousRuntime: {
        resolvedProfileHash: 'b'.repeat(64),
        profileRoot: 'corrupt-profile-root',
      },
    })
    const response = await POST_RECOVERY(new Request('http://localhost/api/content-profile/recovery', {
      method: 'POST',
      headers: { 'x-rvb-profile-admin-key': 'test-key' },
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      requiresProcessRestart: true,
      state: { stable: { resolvedProfileHash: 'a'.repeat(64) } },
    })
    expect(logProfileEvent).toHaveBeenCalledWith('startup-recovery', expect.objectContaining({
      requiresProcessRestart: true,
    }))
    expect(reconcileRuntimePveAuthority).toHaveBeenCalledWith(
      recoveredAuthority,
      'startup-recovery',
    )
    expect(bindStableRuntimeProfile).not.toHaveBeenCalled()
  })

  test('preserves admission during uncertain Client recovery when requested', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    const recoveredAuthority = 'd'.repeat(64)
    recoverRuntimeProfileOnStartup.mockReturnValueOnce({
      state: {
        stable: {
          resolvedProfileHash: 'a'.repeat(64),
          authorityContentHash: recoveredAuthority,
        },
        lastFailure: null,
      },
      requiresProcessRestart: false,
      previousRuntime: { resolvedProfileHash: 'a'.repeat(64), profileRoot: 'stable-root' },
    })
    const response = await POST_RECOVERY(new Request(
      'http://localhost/api/content-profile/recovery?keepAdmissionPaused=1',
      {
        method: 'POST',
        headers: { 'x-rvb-profile-admin-key': 'test-key' },
      },
    ))

    expect(response.status).toBe(200)
    expect(recoverRuntimeProfileOnStartup).toHaveBeenCalledWith({ keepAdmissionPaused: true })
    expect(reconcileRuntimePveAuthority).toHaveBeenCalledWith(
      recoveredAuthority,
      'startup-recovery',
    )
    expect(bindStableRuntimeProfile).not.toHaveBeenCalled()
  })

  test('releases postcommit admission only for the healthy committed stable identity', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'postcommit:activation-b'
    const targetProfileHash = 'b'.repeat(64)
    const authorityContentHash = 'c'.repeat(64)
    readProfileState.mockReturnValueOnce({
      stable: { resolvedProfileHash: targetProfileHash, authorityContentHash },
      activation: null,
    })
    getProfileServerReport.mockResolvedValueOnce({
      healthy: true,
      activationId: null,
      profile: { resolvedProfileHash: targetProfileHash, authorityContentHash },
    })

    const response = await POST_RELEASE(new Request(
      'http://localhost/api/content-profile/activation/release',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rvb-profile-admin-key': 'test-key',
        },
        body: JSON.stringify({ targetProfileHash }),
      },
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      admissionPaused: false,
      wasPaused: true,
    })
    expect(bindStableRuntimeProfile).toHaveBeenCalledOnce()
    expect(reconcileRuntimePveAuthority).toHaveBeenCalledWith(
      authorityContentHash,
      'admission-release',
    )
    expect(reconcileRuntimePveAuthority.mock.invocationCallOrder[0])
      .toBeLessThan(bindStableRuntimeProfile.mock.invocationCallOrder[0])
    expect(logProfileEvent).toHaveBeenCalledWith(
      'activation-admission-release',
      expect.objectContaining({ resolvedProfileHash: targetProfileHash }),
    )
  })

  test('keeps admission closed when PVE cleanup fails during release', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'postcommit:activation-c'
    const targetProfileHash = 'd'.repeat(64)
    const authorityContentHash = 'e'.repeat(64)
    readProfileState.mockReturnValueOnce({ stable: { resolvedProfileHash: targetProfileHash, authorityContentHash }, activation: null })
    getProfileServerReport.mockResolvedValueOnce({ healthy: true, activationId: null, profile: { resolvedProfileHash: targetProfileHash, authorityContentHash } })
    reconcileRuntimePveAuthority.mockRejectedValueOnce(new Error('audit disk unavailable'))

    const response = await POST_RELEASE(new Request('http://localhost/api/content-profile/activation/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rvb-profile-admin-key': 'test-key' },
      body: JSON.stringify({ targetProfileHash }),
    }))

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(bindStableRuntimeProfile).not.toHaveBeenCalled()
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBe('postcommit:activation-c')
  })

  test('persists authenticated postcommit renderer failure evidence without an active transaction', async () => {
    process.env.RVB_PROFILE_ADMIN_KEY = 'test-key'
    recordProfileAuditEvidence.mockReturnValueOnce({
      schemaVersion: 'rvb-profile-audit/v1',
      eventId: 'renderer-failure-evidence',
    })
    const response = await POST_FAILURE(new Request('http://localhost/api/content-profile/activation/failure', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rvb-profile-admin-key': 'test-key',
      },
      body: JSON.stringify({
        evidenceKind: 'postcommit-renderer-failure',
        code: 'PROFILE_RENDERER_RELOAD_FAILED',
        stage: 'renderer-commit-recovery-reload',
        message: 'renderer hash mismatch',
        targetProfileHash: 'c'.repeat(64),
        rollbackTarget: 'previous-stable',
        rollbackSucceeded: null,
      }),
    }))

    expect(response.status).toBe(200)
    expect(recordProfileAuditEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'postcommit-renderer-failure',
      targetProfileHash: 'c'.repeat(64),
    }))
  })
})
