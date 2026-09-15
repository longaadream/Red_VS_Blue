import { expect, it } from 'vitest'
import { StartupWatchdog, STARTUP_PROGRESS_TYPE } from '../../electron-client/startup-watchdog'

const progress = (work: number) => ({ type: STARTUP_PROGRESS_TYPE, stage: 'profile', work, completed: work * 32, total: 1024 })
it('keeps waiting for genuine progress beyond the old total cutoff', () => {
  const w = new StartupWatchdog(0)
  for (let i = 1; i <= 8; i++) {
    expect(w.failure(i * 60_000)).toBeNull()
    expect(w.observe(progress(i), i * 60_000)).toBe(true)
  }
  expect(w.message).toContain('256/1024')
  expect(w.failure(569_999)).toBeNull()
  expect(w.failure(570_000)).toContain('无进展')
})
it('does not accept duplicate, backward or malformed status as work', () => {
  const w = new StartupWatchdog(0)
  w.observe(progress(2), 10_000)
  for (const p of [progress(2), progress(1), { ...progress(3), stage: 'unknown' }, { ...progress(3), work: NaN }]) {
    expect(w.observe(p, 99_000)).toBe(false)
  }
  expect(w.failure(100_000)).toContain('无进展')
})
it('stops even progressing startup at the overall safety limit', () => {
  const w = new StartupWatchdog(0)
  w.observe(progress(1), 899_000)
  expect(w.failure(900_000)).toContain('总时限')
})
it('starts an independent deadline on retry', () => {
  const first = new StartupWatchdog(0)
  expect(first.failure(90_000)).toContain('无进展')
  const retry = new StartupWatchdog(90_000)
  expect(retry.observe(progress(1), 100_000)).toBe(true)
  expect(retry.failure(110_000)).toBeNull()
})
