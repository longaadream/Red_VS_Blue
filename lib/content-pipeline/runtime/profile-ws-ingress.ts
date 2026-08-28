export interface ProfileWsIngressTrackerV1 {
  activeCount: () => number
  tryEnter: () => (() => void) | null
  waitForDrain: (timeoutMs?: number) => Promise<boolean>
}

declare global {
  var __rvbProfileWsIngressV1: ProfileWsIngressTrackerV1 | undefined
}

function isProfileAdmissionPaused(): boolean {
  return Boolean(
    process.env.RVB_PROFILE_ACTIVATION_ID
    || process.env.RVB_PROFILE_ADMISSION_PAUSED,
  )
}

function createProfileWsIngressTrackerV1(): ProfileWsIngressTrackerV1 {
  let active = 0
  const waiters = new Set<() => void>()

  const notifyDrained = () => {
    if (active !== 0) return
    for (const waiter of waiters) waiter()
    waiters.clear()
  }

  return {
    activeCount: () => active,
    tryEnter: () => {
      // The admission fence and this increment execute synchronously on the
      // Node event loop. An activation therefore either observes this task in
      // the drain count or wins the fence and rejects it before it can mutate
      // authoritative room state.
      if (isProfileAdmissionPaused()) return null
      active += 1
      let finished = false
      return () => {
        if (finished) return
        finished = true
        active -= 1
        notifyDrained()
      }
    },
    waitForDrain: (timeoutMs = 10_000) => {
      if (active === 0) return Promise.resolve(true)
      return new Promise(resolve => {
        let settled = false
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          waiters.delete(onDrain)
          resolve(value)
        }
        const onDrain = () => finish(true)
        const timeout = setTimeout(() => finish(false), timeoutMs)
        waiters.add(onDrain)
      })
    },
  }
}

export function getProfileWsIngressTrackerV1(): ProfileWsIngressTrackerV1 {
  return globalThis.__rvbProfileWsIngressV1
    ??= createProfileWsIngressTrackerV1()
}
