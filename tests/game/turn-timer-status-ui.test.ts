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
      remainingMs?: number
      paused?: boolean
      burning?: boolean
      fast?: boolean
    }
    pendingTimer?: {
      status: string
      deadlineAt: number
    }
    now?: number
  }): {
    visible: boolean
    remainingSeconds: number
    clockText: string
    frozenClockText: string
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

  it('shows the response clock while clearly preserving the frozen turn budget', () => {
    const api = loadApi()

    expect(api.create({
      timer: {
        status: 'running',
        deadlineAt: 46_000,
        burnStartsAt: 31_000,
        remainingMs: 34_000,
        paused: true,
      },
      pendingTimer: {
        status: 'running',
        deadlineAt: 20_000,
      },
      now: 8_000,
    })).toMatchObject({
      visible: true,
      remainingSeconds: 12,
      clockText: '00:12',
      frozenClockText: '00:34',
      burning: false,
      fast: false,
      label: '响应计时（回合计时已冻结 00:34）',
    })
  })
})
