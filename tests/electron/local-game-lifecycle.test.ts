import { describe, expect, it } from 'vitest'

import {
  LOCAL_GAME_OPEN_CANCELLED,
  LOCAL_GAME_SHUTDOWN_IN_PROGRESS,
  LocalGameLifecycleGate,
} from '../../electron-client/local-game-lifecycle'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('Electron local game lifecycle gate', () => {
  it('prevents a stale opening from spawning authority after Profile recovery is torn down', async () => {
    const lifecycle = new LocalGameLifecycleGate()
    const profileRecovery = deferred()
    const generation = lifecycle.beginOpening()
    let authoritySpawned = false
    const opening = (async () => {
      await profileRecovery.promise
      lifecycle.assertOpeningCurrent(generation)
      authoritySpawned = true
    })()

    const finishShutdown = lifecycle.beginShutdown()
    finishShutdown()
    profileRecovery.resolve()

    await expect(opening).rejects.toThrow(LOCAL_GAME_OPEN_CANCELLED)
    expect(authoritySpawned).toBe(false)
  })

  it('prevents an in-flight authority startup from reopening the game after teardown begins', async () => {
    const lifecycle = new LocalGameLifecycleGate()
    const authorityStartup = deferred()
    const generation = lifecycle.beginOpening()
    let gameOpened = false
    const opening = (async () => {
      lifecycle.assertOpeningCurrent(generation)
      await authorityStartup.promise
      lifecycle.assertOpeningCurrent(generation)
      gameOpened = true
    })()

    const finishShutdown = lifecycle.beginShutdown()
    authorityStartup.resolve()
    await expect(opening).rejects.toThrow(LOCAL_GAME_OPEN_CANCELLED)
    expect(gameOpened).toBe(false)
    finishShutdown()
  })

  it('allows the opening-owned Profile recovery restart without cancelling itself', () => {
    const lifecycle = new LocalGameLifecycleGate()
    const generation = lifecycle.beginOpening()
    const finishInternalRestart = lifecycle.beginShutdown(false)
    finishInternalRestart()

    expect(() => lifecycle.assertOpeningCurrent(generation)).not.toThrow()
  })

  it('rejects a new opening while teardown is active', () => {
    const lifecycle = new LocalGameLifecycleGate()
    const finishShutdown = lifecycle.beginShutdown()

    expect(() => lifecycle.beginOpening()).toThrow(LOCAL_GAME_SHUTDOWN_IN_PROGRESS)
    finishShutdown()
    expect(() => lifecycle.beginOpening()).not.toThrow()
  })
})
