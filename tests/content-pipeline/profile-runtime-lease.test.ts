import path from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

const rooms = vi.hoisted(() => [] as Array<{ id: string; status: string }>)
const pveLease = vi.hoisted(() => ({
  active: false,
  runIds: [] as string[],
  battleIds: [] as string[],
}))

vi.mock('@/lib/game/room-store', () => ({
  getRoomStore: () => ({ getAllRooms: async () => rooms }),
}))

vi.mock('@/lib/pve/profile-lifecycle', () => ({
  getPveActiveBattleLeaseReportV1: () => ({ ...pveLease }),
}))

vi.mock('@/lib/game/debug-battle', () => ({
  createDebugDuel: vi.fn(),
}))

import {
  beginProfileActivationV1,
  getProfileLeaseReportV1,
  selectRuntimeProfileReferenceV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'
import { getProfileWsIngressTrackerV1 } from '@/lib/content-pipeline/runtime/profile-ws-ingress'
import type {
  ProfileReferenceV1,
  ProfileStateV1,
  ProfileStoreV1,
} from '@/lib/content-pipeline/runtime/profile-store'

const originalAppRoot = process.env.APP_ROOT_DIR
const originalUserData = process.env.USER_DATA_DIR
const originalAdmissionPause = process.env.RVB_PROFILE_ADMISSION_PAUSED
const runtimeGlobals = globalThis as typeof globalThis & { __rvbWss?: unknown }
const originalWebSocketServer = runtimeGlobals.__rvbWss
const originalHttpIngress = globalThis.__rvbProfileHttpIngressV1
const originalWebSocketIngress = globalThis.__rvbProfileWsIngressV1

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
  rooms.splice(0)
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
  if (originalWebSocketServer === undefined) delete runtimeGlobals.__rvbWss
  else runtimeGlobals.__rvbWss = originalWebSocketServer
  if (originalHttpIngress === undefined) delete globalThis.__rvbProfileHttpIngressV1
  else globalThis.__rvbProfileHttpIngressV1 = originalHttpIngress
  if (originalWebSocketIngress === undefined) delete globalThis.__rvbProfileWsIngressV1
  else globalThis.__rvbProfileWsIngressV1 = originalWebSocketIngress
})

describe('RED-115 active-game Profile lease', () => {
  test('never authorizes candidate or previous stable without the active transaction token', () => {
    const stable = reference('1', 'a')
    const candidate = reference('2', 'b')
    const previousStable = reference('3', 'c')
    const state = {
      schemaVersion: 'rvb-profile-state/v1',
      revision: 3,
      stable,
      candidate,
      previousStable,
      activation: null,
      lastFailure: null,
    } satisfies ProfileStateV1

    expect(() => selectRuntimeProfileReferenceV1(
      state,
      candidate.resolvedProfileHash,
      undefined,
    )).toThrow(/PROFILE_ACTIVATION_MISMATCH/)
    expect(() => selectRuntimeProfileReferenceV1(
      state,
      previousStable.resolvedProfileHash,
      undefined,
    )).toThrow(/PROFILE_ACTIVATION_MISMATCH/)
    expect(selectRuntimeProfileReferenceV1(
      state,
      stable.resolvedProfileHash,
      undefined,
    )).toBe(stable)
  })

  test('authorizes only the current candidate with the exact active transaction token', () => {
    const stable = reference('4', 'a')
    const candidate = reference('5', 'b')
    const previousStable = reference('6', 'c')
    const state = {
      schemaVersion: 'rvb-profile-state/v1',
      revision: 4,
      stable,
      candidate,
      previousStable,
      activation: {
        activationId: 'activation-current-candidate',
        targetProfileHash: candidate.resolvedProfileHash,
        stableProfileHash: stable.resolvedProfileHash,
        requestedAt: '2026-08-28T00:00:00.000Z',
      },
      lastFailure: null,
    } satisfies ProfileStateV1

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
    expect(() => selectRuntimeProfileReferenceV1(
      state,
      previousStable.resolvedProfileHash,
      'activation-current-candidate',
    )).toThrow(/PROFILE_ACTIVATION_MISMATCH/)
  })

  test('reports only in-progress rooms as active authority leases', async () => {
    rooms.push(
      { id: 'waiting-room', status: 'waiting' },
      { id: 'active-battle', status: 'in-progress' },
      { id: 'finished-room', status: 'finished' },
    )

    await expect(getProfileLeaseReportV1()).resolves.toEqual({
      active: true,
      roomIds: ['active-battle'],
    })
  })

  test('includes an active PVE battle in the authority lease', async () => {
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

  test('rejects authority reload with PROFILE_IN_USE before creating a transaction', async () => {
    const stable = reference('a', 'c')
    const candidate = reference('b', 'd')
    const beginActivation = vi.fn()
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({
          stable,
          candidate,
          previousStable: null,
          activation: null,
        }),
        beginActivation,
      } as unknown as ProfileStoreV1,
    }
    pveLease.active = true
    pveLease.runIds.push('pve-run-active')
    pveLease.battleIds.push('pve-battle-active')

    await expect(beginProfileActivationV1(candidate.resolvedProfileHash))
      .rejects.toThrow('PROFILE_IN_USE: pve-run-active')
    expect(beginActivation).not.toHaveBeenCalled()
  })

  test('pauses admission and drains an already accepted HTTP start before checking leases', async () => {
    const stable = reference('7', 'a')
    const candidate = reference('8', 'b')
    const beginActivation = vi.fn()
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({
          stable,
          candidate,
          previousStable: null,
          activation: null,
        }),
        beginActivation,
      } as unknown as ProfileStoreV1,
    }
    let releaseDrain!: () => void
    const drained = new Promise<boolean>(resolve => {
      releaseDrain = () => resolve(true)
    })
    globalThis.__rvbProfileHttpIngressV1 = {
      activeCount: () => 1,
      waitForDrain: vi.fn(() => drained),
    }
    const terminate = vi.fn()
    runtimeGlobals.__rvbWss = { clients: new Set([{ terminate }]) }

    const activation = beginProfileActivationV1(candidate.resolvedProfileHash)
    await vi.waitFor(() => {
      expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toMatch(/^activation-plan-/)
    })
    rooms.push({ id: 'late-http-start', status: 'in-progress' })
    releaseDrain()

    await expect(activation).rejects.toThrow('PROFILE_IN_USE: late-http-start')
    expect(beginActivation).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBeUndefined()
  })

  test('drains an accepted WebSocket command before checking leases and rejects later commands', async () => {
    const stable = reference('d', 'a')
    const candidate = reference('e', 'b')
    const beginActivation = vi.fn()
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({
          stable,
          candidate,
          previousStable: null,
          activation: null,
        }),
        beginActivation,
      } as unknown as ProfileStoreV1,
    }

    const ingress = getProfileWsIngressTrackerV1()
    const finishAcceptedCommand = ingress.tryEnter()
    expect(finishAcceptedCommand).toBeTypeOf('function')

    const activation = beginProfileActivationV1(candidate.resolvedProfileHash)
    await vi.waitFor(() => {
      expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toMatch(/^activation-plan-/)
      expect(ingress.activeCount()).toBe(1)
    })
    expect(ingress.tryEnter()).toBeNull()

    rooms.push({ id: 'late-ws-start', status: 'in-progress' })
    finishAcceptedCommand!()

    await expect(activation).rejects.toThrow('PROFILE_IN_USE: late-ws-start')
    expect(beginActivation).not.toHaveBeenCalled()
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBeUndefined()
  })

  test('a failed planner cannot clear a concurrent winner activation fence', async () => {
    const stable = reference('9', 'a')
    const candidate = reference('a', 'b')
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    globalThis.__rvbProfileHttpIngressV1 = {
      activeCount: () => 0,
      waitForDrain: vi.fn().mockResolvedValue(true),
    }
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({
          stable,
          candidate,
          previousStable: null,
          activation: null,
        }),
        beginActivation: () => {
          process.env.RVB_PROFILE_ADMISSION_PAUSED = 'concurrent-winner-activation'
          throw new Error('PROFILE_STORE_BUSY')
        },
      } as unknown as ProfileStoreV1,
    }

    await expect(beginProfileActivationV1(candidate.resolvedProfileHash))
      .rejects.toThrow('PROFILE_STORE_BUSY')
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBe('concurrent-winner-activation')
  })

  test('an idempotent duplicate plan preserves the existing activation gate', async () => {
    const stable = reference('b', 'a')
    const candidate = reference('c', 'b')
    const existing = {
      activationId: 'existing-activation',
      targetProfileHash: candidate.resolvedProfileHash,
      stableProfileHash: stable.resolvedProfileHash,
      requestedAt: '2026-08-28T00:00:00.000Z',
    }
    const beginActivation = vi.fn()
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    rooms.push({ id: 'room-created-after-original-plan', status: 'in-progress' })
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({
          stable,
          candidate,
          previousStable: null,
          activation: existing,
        }),
        beginActivation,
        profileRoot: () => path.resolve('candidate-profile'),
      } as unknown as ProfileStoreV1,
    }

    await expect(beginProfileActivationV1(candidate.resolvedProfileHash))
      .resolves.toMatchObject({ activationId: existing.activationId })
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBe(existing.activationId)
    expect(beginActivation).not.toHaveBeenCalled()
  })

  test('closes new-game admission as soon as the activation transaction begins', async () => {
    const stable = reference('e', 'f')
    const candidate = reference('f', 'f')
    process.env.APP_ROOT_DIR = path.resolve('test-app-root')
    process.env.USER_DATA_DIR = path.resolve('test-user-data')
    const transaction = {
      activationId: 'activation-fence',
      targetProfileHash: candidate.resolvedProfileHash,
      stableProfileHash: stable.resolvedProfileHash,
      requestedAt: '2026-08-28T00:00:00.000Z',
    }
    globalThis.__rvbProfileRuntimeContextV1 = {
      appRoot: path.resolve('test-app-root'),
      userDataDir: path.resolve('test-user-data'),
      store: {
        readState: () => ({ stable, candidate, previousStable: null, activation: null }),
        beginActivation: () => transaction,
        profileRoot: () => path.resolve('candidate-profile'),
      } as unknown as ProfileStoreV1,
    }
    const terminateA = vi.fn()
    const terminateB = vi.fn()
    runtimeGlobals.__rvbWss = {
      clients: new Set([
        { terminate: terminateA },
        { terminate: terminateB },
      ]),
    }

    await beginProfileActivationV1(candidate.resolvedProfileHash)
    expect(process.env.RVB_PROFILE_ADMISSION_PAUSED).toBe(transaction.activationId)
    expect(terminateA).toHaveBeenCalledOnce()
    expect(terminateB).toHaveBeenCalledOnce()
  })
})
