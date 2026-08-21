import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

type TurnTimerStatusApi = {
  create(input: {
    timer?: {
      status: string
      deadlineAt: number
      burnStartsAt: number
      burning?: boolean
      fast?: boolean
    }
    now?: number
  }): {
    visible: boolean
    remainingSeconds: number
    clockText: string
    burning: boolean
    fast: boolean
    label: string
  }
}

function loadApi(): TurnTimerStatusApi {
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/battle-ui/turn-timer-status.js'),
    'utf8',
  )
  const browserWindow: Record<string, unknown> = {}
  new Script(source, { filename: 'turn-timer-status.js' }).runInContext(
    createContext({ window: browserWindow }),
  )
  return browserWindow.RvBTurnTimerStatus as TurnTimerStatusApi
}

describe('RED-36 turn timer status view', () => {
  it('derives its countdown from the server deadline and calibrated authority time', () => {
    const api = loadApi()
    const timer = {
      status: 'running',
      deadlineAt: 46_000,
      burnStartsAt: 31_000,
    }

    expect(api.create({ timer, now: 1_000 })).toMatchObject({
      visible: true,
      remainingSeconds: 45,
      clockText: '00:45',
      burning: false,
      fast: false,
    })
    expect(api.create({ timer, now: 31_001 })).toMatchObject({
      remainingSeconds: 15,
      clockText: '00:15',
      burning: true,
      label: '烧绳阶段',
    })
    expect(timer).toEqual({ status: 'running', deadlineAt: 46_000, burnStartsAt: 31_000 })
  })

  it('distinguishes a player-local fast turn and hides stopped timers', () => {
    const api = loadApi()
    const fast = {
      status: 'running',
      deadlineAt: 21_000,
      burnStartsAt: 6_000,
      fast: true,
    }

    expect(api.create({ timer: fast, now: 1_000 })).toMatchObject({
      clockText: '00:20',
      fast: true,
      label: '快速烧绳',
    })
    expect(api.create({ timer: { ...fast, status: 'stopped' }, now: 1_000 })).toMatchObject({
      visible: false,
      clockText: '--:--',
    })
  })
})
