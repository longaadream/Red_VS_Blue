import path from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

const pveLease = vi.hoisted(() => ({
  active: false,
  runIds: [] as string[],
  battleIds: [] as string[],
}))

vi.mock('@/lib/pve/profile-lifecycle', () => ({
  getPveActiveBattleLeaseReportV1: () => ({ ...pveLease }),
}))

vi.mock('@/lib/game/debug-battle', () => ({ createDebugDuel: vi.fn() }))

import {
  beginProfileActivationV1,
  getProfileLeaseReportV1,
  selectRuntimeProfileReferenceV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'
import type {
  ProfileReferenceV1,
  ProfileStateV1,
  ProfileStoreV1,
} from '@/lib/content-pipeline/runtime/profile-store'

const originalAppRoot = process.env.APP_ROOT_DIR
const originalUserData = process.env.USER_DATA_DIR
const originalAdmissionPause = process.env.RVB_PROFILE_ADMISSION_PAUSED
const originalHttpIngress = globalThis.__rvbProfileHttpIngressV1

function reference(hashMarker: string, authorityMarker: string): ProfileReferenceV1 {
  return {
    schemaVersion: 'rvb-profile-reference/v1',
    kind: 'installed',
    resolvedProfileHash: hashMarker.repeat(64),
    authorityContentHash: authorityMarker.repeat(64),
    compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
    capabilities: ['game-data'],
    packageId: `rvb.${hashMarker}`,
    version: '1.0.0',
    installedAt: '2026-08-28T00:00:00.000Z',
  }
}

afterEach(() => {
  pveLease.active = false
  pveLease.runIds.splice(0)
  pveLease.battleIds.splice(0)
  delete globalThis.__rvbProfileRuntimeContextV1
  if (originalAppRoot === undefined) delete process.env.APP_ROOT_DIR
  else process.env.APP_ROOT_DIR = originalAppRoot
  if (originalUserData === undefined) delete process.env.USER_DATA_DIR
  else process.env.USER_DATA_DIR = originalUserData
  if (originalAdmissionPause === undefined) delete process.env.RVB_PROFILE_ADMISSION_PAUSED
  else process.env.RVB_PROFILE_ADMISSION_PAUSED = originalAdmissionPause
  if (originalHttpIngress === undefined) delete globalThis.__rvbProfileHttpIngressV1
  else globalThis.__rvbProfileHttpIngressV1 = originalHttpIngress
})

describe('Profile runtime lease after Colyseus cutover', () => {
  test('authorizes only stable or the exact active candidate transaction', () => {
    const stable = reference('1', 'a')
    const candidate = reference('2', 'b')
    const state = {
      schemaVersion: 'rvb-profile-state/v1',
      revision: 3,
      stable,
      candidate,
      previousStable: null,
      activation: {
        activationId: 'activation-current-candidate',
        targetProfileHash: candidate.resolvedProfileHash,
        stableProfileHash: stable.resolvedProfileHash,
        requestedAt: '2026-08-28T00:00:00.000Z',
      },
      lastFailure: null,
    } satisfies ProfileStateV1

    expect(selectRuntimeProfileReferenceV1(state, stable.resolvedProfileHash, undefined)).toBe(stable)
    expect(selectRuntimeProfileReferenceV1(
      state,
      candidate.resolvedProfileHash,
      'activation-current-candidate',
    )).toBe(candidate)
    expect(() => selectRuntimeProfileReferenceV1(
      state,
      candidate.resolvedProfileHash,
      'wrong-token',
    )).toThrow(/PROFILE_ACTIVATION_MISMATCH/)
  })

  test('Profile owns only PVE leases; Colyseus owns multiplayer rooms', async () => {
    await expect(getProfileLeaseReportV1()).resolves.toEqual({ active: false, roomIds: [] })

    pveLease.active = true
    pveLease.runIds.push('run-active')
    pveLease.battleIds.push('battle-active')
    await expect(getProfileLeaseReportV1()).resolves.toEqual({
      active: true,
      roomIds: [],
      pveRunIds: ['run-active'],
      pveBattleIds: ['battle-active'],
    })
  })

  test('drains accepted Profile HTTP work before checking the PVE lease', async () => {
    const stable = reference('7', 'a')
    const candidate = reference('8', 'b')
    const beginActivation = vi.fn()
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({ stable, candidate, previousStable: null, activation: null }),
        beginActivation,
      } as unknown as ProfileStoreV1,
    }
    let releaseDrain!: () => void
    const drained = new Promise<boolean>(resolve => { releaseDrain = () => resolve(true) })
    globalThis.__rvbProfileHttpIngressV1 = {
      activeCount: () => 1,
      waitForDrain: vi.fn(() => drained),
    }

    const activation = beginProfileActivationV1(candidate.resolvedProfileHash)
    await vi.waitFor(() => {
      expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toMatch(/^activation-plan-/)
    })
    pveLease.active = true
    pveLease.runIds.push('late-pve-run')
    releaseDrain()

    await expect(activation).rejects.toThrow('PROFILE_IN_USE: late-pve-run')
    expect(beginActivation).not.toHaveBeenCalled()
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBeUndefined()
  })
})
